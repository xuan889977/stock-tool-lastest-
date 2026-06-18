const express = require("express");
const fetch = require("node-fetch");
const YahooFinance = require("yahoo-finance2").default;

const app = express();
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const quoteCache = new Map();
const analysisCache = new Map();
const intradayCache = new Map();
const aiCache = new Map();

const QUOTE_TTL_MS = 1500;
const ANALYSIS_TTL_MS = 60000;
const INTRADAY_TTL_MS = 5000;
const AI_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 6500;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AI_PROVIDER = (process.env.AI_PROVIDER || "auto").toLowerCase();

app.use(express.json({ limit: "1mb" }));

function normalizeSymbol(value) {
  const cleaned = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:.-]/g, "");

  if (!cleaned) return "";

  const [prefix, code] = cleaned.includes(":") ? cleaned.split(":") : ["", cleaned];
  const exchangeMap = {
    HK: ".HK",
    HKG: ".HK",
    SEHK: ".HK",
    SH: ".SS",
    SHA: ".SS",
    SSE: ".SS",
    SZ: ".SZ",
    SZA: ".SZ",
    SZSE: ".SZ",
    JP: ".T",
    TYO: ".T",
    TSE: ".T",
    LSE: ".L",
    LON: ".L"
  };

  if (exchangeMap[prefix] && code && !code.includes(".")) {
    return code + exchangeMap[prefix];
  }

  return code || cleaned;
}

function getCached(cache, key, ttl) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > ttl) return null;
  return cached.data;
}

function getStaleCached(cache, key, maxAge) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.time > maxAge) return null;
  return cached.data;
}

function setCached(cache, key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(from, to) {
  if (!from || !to) return null;
  return ((to - from) / from) * 100;
}

function compactHistory(rows) {
  return rows
    .filter(row => row.close)
    .map(row => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume || 0
    }));
}

function getMarketState(meta) {
  if (meta.marketState) return meta.marketState;

  const now = Math.floor(Date.now() / 1000);
  const periods = meta.currentTradingPeriod || {};
  const toEpoch = value => {
    if (!value) return null;
    if (typeof value === "number") return value;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  };

  const inPeriod = period => {
    const start = toEpoch(period && period.start);
    const end = toEpoch(period && period.end);
    return start && end && now >= start && now < end;
  };

  if (inPeriod(periods.pre)) return "PRE";
  if (inPeriod(periods.regular)) return "REGULAR";
  if (inPeriod(periods.post)) return "POST";

  return "CLOSED";
}

function getLatestIndex(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && values[i] !== undefined) return i;
  }
  return -1;
}

async function fetchYahooChart(symbol, options) {
  const params = new URLSearchParams(options);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  const res = await fetch(url, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      "user-agent": "Mozilla/5.0 stock-tool/1.0",
      "accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Yahoo chart HTTP ${res.status}`);
  }

  const body = await res.json();
  const error = body.chart && body.chart.error;

  if (error) {
    throw new Error(error.description || error.code || "Yahoo chart error");
  }

  const result = body.chart && body.chart.result && body.chart.result[0];

  if (!result) {
    throw new Error("Yahoo chart returned empty result");
  }

  return result;
}

function quoteFromChart(symbol, chart) {
  const meta = chart.meta || {};
  const quote = chart.indicators && chart.indicators.quote && chart.indicators.quote[0] || {};
  const closes = quote.close || [];
  const latestIndex = getLatestIndex(closes);
  const price = toNumber(meta.regularMarketPrice) || toNumber(closes[latestIndex]);
  const previousClose = toNumber(meta.previousClose) || toNumber(meta.chartPreviousClose);
  const dayHigh = toNumber(meta.regularMarketDayHigh) || Math.max(...(quote.high || []).filter(Number.isFinite));
  const dayLow = toNumber(meta.regularMarketDayLow) || Math.min(...(quote.low || []).filter(Number.isFinite));
  const dayVolume = toNumber(meta.regularMarketVolume) || 0;
  const time = meta.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : latestIndex >= 0 && chart.timestamp && chart.timestamp[latestIndex]
      ? new Date(chart.timestamp[latestIndex] * 1000).toISOString()
      : new Date().toISOString();

  if (!price) {
    throw new Error("Yahoo chart quote missing price");
  }

  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || meta.longName || meta.symbol || symbol,
    longName: meta.longName || meta.shortName || meta.symbol || symbol,
    regularMarketPrice: price,
    regularMarketOpen: toNumber(meta.regularMarketOpen) || toNumber((quote.open || [])[0]),
    regularMarketPreviousClose: previousClose,
    regularMarketDayHigh: Number.isFinite(dayHigh) ? dayHigh : null,
    regularMarketDayLow: Number.isFinite(dayLow) ? dayLow : null,
    regularMarketChange: previousClose ? price - previousClose : null,
    regularMarketChangePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : null,
    regularMarketVolume: dayVolume,
    averageDailyVolume3Month: toNumber(meta.averageDailyVolume3Month),
    averageDailyVolume10Day: toNumber(meta.averageDailyVolume10Day),
    bid: toNumber(meta.bid),
    ask: toNumber(meta.ask),
    bidSize: toNumber(meta.bidSize),
    askSize: toNumber(meta.askSize),
    marketState: getMarketState(meta),
    regularMarketTime: time,
    source: "yahoo-chart"
  };
}

function quoteFromChartData(symbol, chartData) {
  const meta = chartData.meta || {};
  const rows = rowsFromChartQuotes(chartData.quotes);
  const latest = rows[rows.length - 1] || {};
  const price = toNumber(meta.regularMarketPrice) || latest.close;
  const previousClose = toNumber(meta.previousClose) || toNumber(meta.chartPreviousClose);

  if (!price) {
    throw new Error("Yahoo chart fallback missing price");
  }

  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || meta.longName || meta.symbol || symbol,
    longName: meta.longName || meta.shortName || meta.symbol || symbol,
    regularMarketPrice: price,
    regularMarketOpen: latest.open,
    regularMarketPreviousClose: previousClose,
    regularMarketDayHigh: toNumber(meta.regularMarketDayHigh),
    regularMarketDayLow: toNumber(meta.regularMarketDayLow),
    regularMarketChange: previousClose ? price - previousClose : null,
    regularMarketChangePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : null,
    regularMarketVolume: toNumber(meta.regularMarketVolume) || 0,
    bid: toNumber(meta.bid),
    ask: toNumber(meta.ask),
    bidSize: toNumber(meta.bidSize),
    askSize: toNumber(meta.askSize),
    marketState: getMarketState(meta),
    regularMarketTime: meta.regularMarketTime || latest.date || new Date().toISOString(),
    source: "yahoo-finance2-chart"
  };
}

function historyFromChart(chart) {
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators && chart.indicators.quote && chart.indicators.quote[0] || {};
  const open = quote.open || [];
  const high = quote.high || [];
  const low = quote.low || [];
  const close = quote.close || [];
  const volume = quote.volume || [];

  return timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000),
    open: open[index],
    high: high[index],
    low: low[index],
    close: close[index],
    volume: volume[index] || 0
  })).filter(row => row.close);
}

function rowsFromChartQuotes(rows) {
  return (rows || []).map(row => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume || 0
  })).filter(row => row.close);
}

async function getQuote(symbol) {
  const cached = getCached(quoteCache, symbol, QUOTE_TTL_MS);
  if (cached) return cached;
  const stale = getStaleCached(quoteCache, symbol, 30 * 60 * 1000);

  try {
    const chart = await fetchYahooChart(symbol, {
      range: "1d",
      interval: "1m",
      includePrePost: "true"
    });
    const quote = quoteFromChart(symbol, chart);
    setCached(quoteCache, symbol, quote);
    return quote;
  } catch (chartErr) {
    try {
      const quote = await yahooFinance.quote(symbol);

      if (!quote || !quote.regularMarketPrice) {
        throw chartErr;
      }

      quote.source = "yahoo-finance2";
      setCached(quoteCache, symbol, quote);
      return quote;
    } catch (fallbackErr) {
      if (stale) {
        return {
          ...stale,
          stale: true,
          source: `${stale.source || "cache"}-stale`
        };
      }

      throw fallbackErr;
    }
  }
}

async function getHistory(symbol) {
  const chart = await fetchYahooChart(symbol, {
    range: "3mo",
    interval: "1d",
    includePrePost: "false"
  });

  return historyFromChart(chart);
}

async function getIntraday(symbol) {
  const cached = getCached(intradayCache, symbol, INTRADAY_TTL_MS);
  if (cached) return cached;
  const stale = getStaleCached(intradayCache, symbol, 30 * 60 * 1000);

  let quote;
  let rows;
  let source = "yahoo-chart";

  try {
    const chart = await fetchYahooChart(symbol, {
      range: "1d",
      interval: "1m",
      includePrePost: "true"
    });
    quote = quoteFromChart(symbol, chart);
    rows = historyFromChart(chart);
  } catch (chartErr) {
    try {
      const period1 = new Date(Date.now() - 36 * 60 * 60 * 1000);
      const chartData = await yahooFinance.chart(symbol, {
        period1,
        period2: new Date(),
        interval: "1m"
      });
      quote = quoteFromChartData(symbol, chartData);
      rows = rowsFromChartQuotes(chartData.quotes);
      source = "yahoo-finance2-chart";
    } catch (fallbackErr) {
      try {
        quote = await getQuote(symbol);
        rows = [{
          date: new Date(quote.regularMarketTime || Date.now()),
          open: quote.regularMarketPrice,
          high: quote.regularMarketPrice,
          low: quote.regularMarketPrice,
          close: quote.regularMarketPrice,
          volume: quote.regularMarketVolume || 0
        }];
        source = quote.source || "quote-fallback";
      } catch (quoteErr) {
        if (stale) {
          return {
            ...stale,
            stale: true,
            source: `${stale.source || "cache"}-stale`
          };
        }

        throw quoteErr;
      }
    }
  }

  const quoteRows = rows.map(row => ({
    time: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume || 0
  }));
  const data = {
    symbol: quote.symbol,
    marketState: quote.marketState,
    source,
    stale: Boolean(quote.stale),
    previousClose: quote.regularMarketPreviousClose,
    price: quote.regularMarketPrice,
    time: quote.regularMarketTime || new Date().toISOString(),
    points: quoteRows.slice(-240)
  };

  setCached(intradayCache, symbol, data);
  return data;
}

function quoteResponse(quote) {
  return {
    symbol: quote.symbol,
    name: quote.shortName || quote.longName || quote.symbol,
    price: quote.regularMarketPrice,
    open: quote.regularMarketOpen,
    previousClose: quote.regularMarketPreviousClose,
    dayHigh: quote.regularMarketDayHigh,
    dayLow: quote.regularMarketDayLow,
    change: quote.regularMarketChange,
    changePercent: quote.regularMarketChangePercent,
    volume: quote.regularMarketVolume || 0,
    bid: quote.bid,
    ask: quote.ask,
    bidSize: quote.bidSize,
    askSize: quote.askSize,
    marketState: quote.marketState || "UNKNOWN",
    time: quote.regularMarketTime || new Date().toISOString(),
    source: quote.source || "yahoo"
  };
}

async function getMarketContext() {
  const symbols = [
    { symbol: "SPY", name: "标普500 ETF" },
    { symbol: "QQQ", name: "纳指100 ETF" },
    { symbol: "IWM", name: "罗素2000 ETF" },
    { symbol: "^VIX", name: "VIX恐慌指数" }
  ];

  const quotes = await Promise.all(symbols.map(async item => {
    try {
      const quote = await getQuote(item.symbol);
      return {
        symbol: item.symbol,
        name: item.name,
        price: quote.regularMarketPrice,
        changePercent: quote.regularMarketChangePercent,
        volume: quote.regularMarketVolume || 0,
        marketState: quote.marketState || "UNKNOWN"
      };
    } catch (err) {
      return {
        symbol: item.symbol,
        name: item.name,
        error: err.message
      };
    }
  }));

  const spy = quotes.find(row => row.symbol === "SPY");
  const qqq = quotes.find(row => row.symbol === "QQQ");
  const iwm = quotes.find(row => row.symbol === "IWM");
  const vix = quotes.find(row => row.symbol === "^VIX");
  const riskOnCount = [spy, qqq, iwm].filter(row => toNumber(row && row.changePercent) > 0.2).length;
  const riskOffCount = [spy, qqq, iwm].filter(row => toNumber(row && row.changePercent) < -0.2).length;
  const vixChange = toNumber(vix && vix.changePercent);

  let regime = "震荡";
  let type = "neutral";
  let comment = "大盘方向暂不明确，个股信号需要更多确认。";

  if (riskOnCount >= 2 && (!vixChange || vixChange < 3)) {
    regime = "风险偏好较强";
    type = "good";
    comment = "主要指数偏强，个股多头信号更容易延续。";
  } else if (riskOffCount >= 2 || (vixChange && vixChange > 5)) {
    regime = "风险偏好较弱";
    type = "bad";
    comment = "主要指数走弱或波动率抬升，个股信号需要降低仓位和预期。";
  }

  return {
    regime,
    type,
    comment,
    quotes,
    updatedAt: new Date().toISOString()
  };
}

function buildRuleAiAnalysis(context) {
  const volume = context.volumeAnalysis || {};
  const history = context.historyAnalysis || {};
  const live = context.liveMetrics || {};
  const market = context.marketContext || {};
  const reasons = [];
  let score = 50;

  if (volume.match === "价涨量增") {
    score += 18;
    reasons.push({ text: "个股分时价涨量增，上涨有成交量配合", type: "good" });
  } else if (volume.match === "价涨量缩") {
    score -= 6;
    reasons.push({ text: "个股价涨量缩，短线不适合追高", type: "neutral" });
  } else if (volume.match === "价跌量增") {
    score -= 24;
    reasons.push({ text: "个股价跌量增，卖压偏强", type: "bad" });
  } else if (volume.match === "价跌量缩") {
    score -= 2;
    reasons.push({ text: "个股价跌量缩，恐慌不强但还没转强", type: "neutral" });
  }

  if (volume.trend === "量能递增") score += 8;
  if (volume.trend === "量能衰减") score -= 8;

  if (history.rating && history.rating.type === "buy") {
    score += 12;
    reasons.push({ text: `历史量价偏强：${history.rating.text}`, type: "good" });
  } else if (history.rating && history.rating.type === "risk") {
    score -= 14;
    reasons.push({ text: `历史量价有风险：${history.rating.text}`, type: "bad" });
  }

  if (live.vwap && live.latestPrice) {
    if (live.latestPrice > live.vwap) {
      score += 8;
      reasons.push({ text: "现价站上VWAP，盘中均价支撑较好", type: "good" });
    } else {
      score -= 8;
      reasons.push({ text: "现价低于VWAP，短线承压", type: "bad" });
    }
  }

  if (market.type === "good") {
    score += 10;
    reasons.push({ text: `大盘环境：${market.regime}，有利于个股信号延续`, type: "good" });
  } else if (market.type === "bad") {
    score -= 14;
    reasons.push({ text: `大盘环境：${market.regime}，需要降低追涨意愿`, type: "bad" });
  } else if (market.regime) {
    reasons.push({ text: `大盘环境：${market.regime}，先按个股结构处理`, type: "neutral" });
  }

  score = Math.max(0, Math.min(100, score));

  let recommendation = "中性观察";
  let decision = "谨慎观察";
  let type = "hold";
  let confidence = "中";
  let action = "等待价格、成交量和大盘方向进一步同步。";
  let risk = market.type === "bad" ? "大盘拖累" : "信号不足";

  if (score >= 72) {
    recommendation = "偏推荐盯盘";
    decision = "可重点观察";
    type = "buy";
    confidence = score >= 84 ? "高" : "中高";
    action = "优先等回踩VWAP不破或再次放量上攻，再考虑分批介入。";
    risk = "追高回落";
  } else if (score <= 38) {
    recommendation = "暂不推荐";
    decision = "先不要追";
    type = "risk";
    confidence = score <= 26 ? "高" : "中高";
    action = "先看卖压是否减弱，等重新站回VWAP并放量确认。";
    risk = market.type === "bad" ? "大盘与个股共振转弱" : "卖压偏强";
  }

  if (!reasons.length) {
    reasons.push({ text: "样本不足，等待更多实时量价数据", type: "neutral" });
    confidence = "低";
  }

  return {
    source: "rule-market",
    model: "大盘增强规则模型",
    recommendation,
    decision,
    type,
    confidence,
    score,
    risk,
    action,
    beginnerNote: `${volume.match || "量价结构"}结合${market.regime || "大盘环境"}来看，当前更适合先确认方向，不要只看单根价格涨跌。`,
    summary: `${recommendation}。综合个股分时量价、历史量价和大盘环境，当前评分为${Math.round(score)}分。`,
    reasons: reasons.slice(0, 6),
    market
  };
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw err;
  }
}

function buildModelPrompt(context) {
  return {
    task: "请作为股票量价分析助手，结合个股实时分时、历史量价、大盘环境，给新手可以理解的短线盯盘分析。不要承诺收益，不要给绝对买卖指令。",
    outputSchema: {
      recommendation: "偏推荐盯盘 / 中性观察 / 暂不推荐",
      decision: "给新手看的简短结论",
      type: "buy / hold / risk",
      confidence: "低 / 中 / 中高 / 高",
      score: "0-100",
      risk: "主要风险",
      action: "下一步盯盘动作",
      beginnerNote: "用人话解释量价含义",
      summary: "一句综合分析",
      reasons: [{ text: "原因", type: "good / neutral / bad" }]
    },
    data: context
  };
}

function compactText(value, maxLength = 420) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function callGeminiAnalysis(context, fallback) {
  if (!process.env.GEMINI_API_KEY) return fallback;

  const prompt = buildModelPrompt(context);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: "POST",
    timeout: REQUEST_TIMEOUT_MS + 8000,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "你是谨慎的股票量价分析助手。",
                "请输出一段中文自然语言分析，不要输出JSON，不要输出Markdown。",
                "必须包含：综合结论、为什么、主要风险、下一步盯盘动作。",
                "分析只用于学习参考，不构成投资建议。",
                JSON.stringify(prompt)
              ].join("\n")
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "text/plain",
        temperature: 0.28,
        maxOutputTokens: 700
      }
    })
  });

  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}`);
  }

  const body = await res.json();
  const text = (body.candidates || [])
    .flatMap(candidate => candidate.content && candidate.content.parts || [])
    .map(part => part.text || "")
    .join("");
  const summary = compactText(text);

  if (!summary) {
    throw new Error("Gemini returned empty analysis");
  }

  return {
    ...fallback,
    source: "gemini",
    model: GEMINI_MODEL,
    summary,
    beginnerNote: summary,
    market: context.marketContext,
    reasons: [
      { text: `Gemini综合分析：${summary}`, type: fallback.type === "risk" ? "bad" : fallback.type === "buy" ? "good" : "neutral" },
      ...(fallback.reasons || [])
    ].slice(0, 6)
  };
}

async function callOpenAiAnalysis(context, fallback) {
  if (!process.env.OPENAI_API_KEY) return fallback;

  const prompt = buildModelPrompt(context);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    timeout: REQUEST_TIMEOUT_MS + 8000,
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: "你是谨慎的股票量价分析助手。输出必须是JSON，不要输出Markdown。分析只用于学习参考，不构成投资建议。"
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "stock_ai_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              recommendation: { type: "string" },
              decision: { type: "string" },
              type: { type: "string", enum: ["buy", "hold", "risk"] },
              confidence: { type: "string" },
              score: { type: "number" },
              risk: { type: "string" },
              action: { type: "string" },
              beginnerNote: { type: "string" },
              summary: { type: "string" },
              reasons: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    text: { type: "string" },
                    type: { type: "string", enum: ["good", "neutral", "bad"] }
                  },
                  required: ["text", "type"]
                }
              }
            },
            required: [
              "recommendation",
              "decision",
              "type",
              "confidence",
              "score",
              "risk",
              "action",
              "beginnerNote",
              "summary",
              "reasons"
            ]
          }
        }
      }
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}`);
  }

  const body = await res.json();
  const text = body.output_text || (body.output || [])
    .flatMap(item => item.content || [])
    .map(item => item.text || "")
    .join("");
  const parsed = extractJsonObject(text);

  return {
    ...fallback,
    ...parsed,
    source: "openai",
    model: OPENAI_MODEL,
    market: context.marketContext,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6) : fallback.reasons
  };
}

async function callModelAiAnalysis(context, fallback) {
  if (AI_PROVIDER === "gemini") {
    return callGeminiAnalysis(context, fallback);
  }

  if (AI_PROVIDER === "openai") {
    return callOpenAiAnalysis(context, fallback);
  }

  if (process.env.GEMINI_API_KEY) {
    return callGeminiAnalysis(context, fallback);
  }

  if (process.env.OPENAI_API_KEY) {
    return callOpenAiAnalysis(context, fallback);
  }

  return fallback;
}

function buildVolumePriceAnalysis(symbol, quote, historyRows) {
  const history = compactHistory(historyRows).slice(-30);
  const closes = history.map(row => row.close);
  const volumes = history.map(row => row.volume);
  const recent5 = history.slice(-5);
  const recent20 = history.slice(-20);

  const avgVolume5 = average(recent5.map(row => row.volume));
  const avgVolume20 = average(recent20.map(row => row.volume));
  const high20 = recent20.length ? Math.max(...recent20.map(row => row.high)) : null;
  const low20 = recent20.length ? Math.min(...recent20.map(row => row.low)) : null;
  const latestClose = closes[closes.length - 1] || quote.regularMarketPreviousClose;
  const close5Ago = closes.length >= 5 ? closes[closes.length - 5] : null;
  const close20Ago = closes.length >= 20 ? closes[closes.length - 20] : null;
  const currentPrice = quote.regularMarketPrice;
  const currentVolume = quote.regularMarketVolume || 0;
  const volumeRatio20 = avgVolume20 ? currentVolume / avgVolume20 : null;
  const priceChangePercent = quote.regularMarketChangePercent;

  const signals = [];

  if (volumeRatio20 !== null && volumeRatio20 >= 2 && priceChangePercent > 0) {
    signals.push({ text: "今日放量上涨", type: "good" });
  } else if (volumeRatio20 !== null && volumeRatio20 >= 2 && priceChangePercent < 0) {
    signals.push({ text: "今日放量下跌", type: "bad" });
  } else if (volumeRatio20 !== null && volumeRatio20 < 0.8 && priceChangePercent > 0) {
    signals.push({ text: "价涨量缩，注意背离", type: "neutral" });
  } else if (volumeRatio20 !== null && volumeRatio20 < 0.8 && priceChangePercent < 0) {
    signals.push({ text: "缩量回调", type: "neutral" });
  }

  if (high20 && currentPrice > high20) {
    signals.push({ text: "突破20日高点", type: "good" });
  }

  if (low20 && currentPrice < low20) {
    signals.push({ text: "跌破20日低点", type: "bad" });
  }

  if (!signals.length) {
    signals.push({ text: "历史量价中性", type: "neutral" });
  }

  let rating = "HOLD";
  let ratingText = "持有观察";
  let ratingType = "hold";

  const goodCount = signals.filter(signal => signal.type === "good").length;
  const badCount = signals.filter(signal => signal.type === "bad").length;

  if (goodCount >= 2 && badCount === 0) {
    rating = "STRONG";
    ratingText = "强势盯盘";
    ratingType = "buy";
  } else if (goodCount >= 1 && badCount === 0) {
    rating = "WATCH";
    ratingText = "积极观察";
    ratingType = "buy";
  } else if (badCount >= 1) {
    rating = "RISK";
    ratingText = "风险升高";
    ratingType = "risk";
  }

  return {
    symbol,
    quote: {
      symbol: quote.symbol,
      name: quote.shortName || quote.longName || quote.symbol,
      price: currentPrice,
      open: quote.regularMarketOpen,
      previousClose: quote.regularMarketPreviousClose,
      dayHigh: quote.regularMarketDayHigh,
      dayLow: quote.regularMarketDayLow,
      change: quote.regularMarketChange,
      changePercent: priceChangePercent,
      volume: currentVolume,
      averageVolume: quote.averageDailyVolume3Month || quote.averageDailyVolume10Day,
      bid: quote.bid,
      ask: quote.ask,
      bidSize: quote.bidSize,
      askSize: quote.askSize,
      marketState: quote.marketState || "UNKNOWN",
      time: quote.regularMarketTime || new Date().toISOString()
    },
    metrics: {
      avgVolume5,
      avgVolume20,
      volumeRatio20,
      high20,
      low20,
      latestClose,
      change5Day: percentChange(close5Ago, currentPrice),
      change20Day: percentChange(close20Ago, currentPrice)
    },
    signals,
    rating: {
      code: rating,
      text: ratingText,
      type: ratingType
    },
    history
  };
}

app.get("/api/quote/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(400).json({ error: "股票代码不能为空" });
  }

  try {
    const quote = await getQuote(symbol);

    if (!quote || !quote.regularMarketPrice) {
      return res.status(404).json({ error: "未找到股票数据" });
    }

    res.json(quoteResponse(quote));
  } catch (err) {
    res.status(500).json({
      error: "获取行情数据失败",
      detail: err.message
    });
  }
});

app.get("/api/analysis/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(400).json({ error: "股票代码不能为空" });
  }

  try {
    const cached = getCached(analysisCache, symbol, ANALYSIS_TTL_MS);

    if (cached) {
      return res.json(cached);
    }

    const [quote, historyRows] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol)
    ]);

    if (!quote || !quote.regularMarketPrice) {
      return res.status(404).json({ error: "未找到股票数据" });
    }

    const analysis = buildVolumePriceAnalysis(symbol, quote, historyRows);
    setCached(analysisCache, symbol, analysis);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({
      error: "获取历史量价分析失败",
      detail: err.message
    });
  }
});

app.get("/api/intraday/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(400).json({ error: "股票代码不能为空" });
  }

  try {
    const data = await getIntraday(symbol);
    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: "获取实时分时数据失败",
      detail: err.message
    });
  }
});

app.post("/api/ai-analysis/:symbol", async (req, res) => {
  const symbol = normalizeSymbol(req.params.symbol);

  if (!symbol) {
    return res.status(400).json({ error: "股票代码不能为空" });
  }

  try {
    const cacheKey = `${symbol}:${JSON.stringify(req.body && req.body.volumeAnalysis || {})}`;
    const cached = getCached(aiCache, cacheKey, AI_TTL_MS);

    if (cached) {
      return res.json(cached);
    }

    const [quote, historyRows, marketContext] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol),
      getMarketContext()
    ]);
    const historyAnalysis = buildVolumePriceAnalysis(symbol, quote, historyRows);
    const intraday = await getIntraday(symbol);
    const context = {
      symbol,
      quote: quoteResponse(quote),
      historyAnalysis: {
        metrics: historyAnalysis.metrics,
        rating: historyAnalysis.rating,
        signals: historyAnalysis.signals
      },
      intradaySummary: {
        points: intraday.points.length,
        firstPoint: intraday.points[0],
        lastPoint: intraday.points[intraday.points.length - 1],
        recentPoints: intraday.points.slice(-20)
      },
      volumeAnalysis: req.body && req.body.volumeAnalysis || {},
      liveMetrics: req.body && req.body.liveMetrics || {},
      localRule: req.body && req.body.localRule || {},
      marketContext
    };
    const fallback = buildRuleAiAnalysis(context);

    let ai = fallback;

    try {
      ai = await callModelAiAnalysis(context, fallback);
    } catch (modelErr) {
      ai = {
        ...fallback,
        source: "rule-market",
        model: "大盘增强规则模型",
        modelError: modelErr.message
      };
    }

    setCached(aiCache, cacheKey, ai);
    res.json(ai);
  } catch (err) {
    res.status(500).json({
      error: "获取AI综合分析失败",
      detail: err.message
    });
  }
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString()
  });
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务启动成功:", PORT);
});
