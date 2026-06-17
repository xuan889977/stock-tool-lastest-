const express = require("express");
const fetch = require("node-fetch");
const YahooFinance = require("yahoo-finance2").default;

const app = express();
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const quoteCache = new Map();
const analysisCache = new Map();
const intradayCache = new Map();

const QUOTE_TTL_MS = 1500;
const ANALYSIS_TTL_MS = 60000;
const INTRADAY_TTL_MS = 5000;
const REQUEST_TIMEOUT_MS = 6500;

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
  if (Date.now() - cached.time > ttl) {
    cache.delete(key);
    return null;
  }
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
    const quote = await yahooFinance.quote(symbol);

    if (!quote || !quote.regularMarketPrice) {
      throw chartErr;
    }

    quote.source = "yahoo-finance2";
    setCached(quoteCache, symbol, quote);
    return quote;
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

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务启动成功:", PORT);
});
