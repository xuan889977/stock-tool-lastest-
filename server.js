const express = require("express");
const YahooFinance = require("yahoo-finance2").default;

const app = express();
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^[A-Z]+:/, "")
    .replace(/[^A-Z0-9.-]/g, "");
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
    .filter(row => row.close && row.volume)
    .map(row => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume
    }));
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
    const quote = await yahooFinance.quote(symbol);

    if (!quote || !quote.regularMarketPrice) {
      return res.status(404).json({ error: "未找到股票数据" });
    }

    res.json({
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
      time: quote.regularMarketTime || new Date().toISOString()
    });
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
    const period2 = new Date();
    const period1 = new Date();
    period1.setDate(period1.getDate() - 70);

    const [quote, chartData] = await Promise.all([
      yahooFinance.quote(symbol),
      yahooFinance.chart(symbol, {
        period1,
        period2,
        interval: "1d"
      })
    ]);

    if (!quote || !quote.regularMarketPrice) {
      return res.status(404).json({ error: "未找到股票数据" });
    }

    res.json(buildVolumePriceAnalysis(symbol, quote, chartData.quotes || []));
  } catch (err) {
    res.status(500).json({
      error: "获取历史量价分析失败",
      detail: err.message
    });
  }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务启动成功:", PORT);
});
