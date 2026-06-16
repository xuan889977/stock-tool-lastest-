const express = require("express");
const YahooFinance = require("yahoo-finance2").default;

const app = express();
const yahooFinance = new YahooFinance();

app.get("/", (req, res) => {
  res.send(`
    <h1>量价分析工具</h1>

    <form action="/analyze">
      <input name="symbol" placeholder="输入股票代码，例如 TSLA">
      <button type="submit">开始分析</button>
    </form>
  `);
});

app.get("/analyze", async (req, res) => {
  try {
    const symbol = req.query.symbol || "TSLA";
    const quote = await yahooFinance.quote(symbol);

    let score = 50;

    if (quote.regularMarketChangePercent > 0) {
      score = score + 20;
    } else {
      score = score - 20;
    }

    if (quote.regularMarketVolume > 30000000) {
      score = score + 10;
    }

    let trend = "下跌 📉";
    if (quote.regularMarketChangePercent > 0) {
      trend = "上涨 📈";
    }

    let advice = "RISK 风险较高";
    if (score >= 80) {
      advice = "BUY 买入观察";
    } else if (score >= 60) {
      advice = "HOLD 持有观察";
    }

    res.send(`
      <h1>分析结果</h1>

      <p>股票代码：${quote.symbol}</p>
      <p>名称：${quote.shortName}</p>
      <p>价格：${quote.regularMarketPrice}</p>
      <p>涨跌：${quote.regularMarketChangePercent}%</p>
      <p>成交量：${quote.regularMarketVolume}</p>
      <p>趋势：${trend}</p>
      <p>量价评分：${score}</p>
      <p>建议：${advice}</p>

      <a href="/">返回首页</a>
    `);
  } catch (err) {
    res.send(`
      <h1>出错了</h1>
      <p>${err.message}</p>
      <a href="/">返回首页</a>
    `);
  }
});

app.listen(3000, () => {
  console.log("服务器启动成功：http://localhost:3000");
});