const express = require("express");
const fetch = require("node-fetch");

const app = express();

const API_KEY = "50FF1VUHA0EB1TWR";

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

    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${API_KEY}`;

    const response = await fetch(url);
    const data = await response.json();

    const quote = data["Global Quote"];

    if (!quote || !quote["05. price"]) {
      throw new Error("没有获取到股票数据，可能是代码错误或API限制");
    }

    const price = Number(quote["05. price"]);
    const changePercentText = quote["10. change percent"];
    const changePercent = Number(changePercentText.replace("%", ""));
    const volume = Number(quote["06. volume"]);

    let trend = "下跌 📉";
    if (changePercent > 0) {
      trend = "上涨 📈";
    }

    let score = 50;

    if (changePercent > 0) {
      score = score + 20;
    } else {
      score = score - 20;
    }

    if (volume > 30000000) {
      score = score + 10;
    }

    let advice = "RISK 风险较高";
    if (score >= 80) {
      advice = "BUY 买入观察";
    } else if (score >= 60) {
      advice = "HOLD 持有观察";
    }

    res.send(`
      <h1>分析结果</h1>

      <p>股票代码：${symbol.toUpperCase()}</p>
      <p>价格：${price}</p>
      <p>涨跌：${changePercentText}</p>
      <p>成交量：${volume}</p>
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`服务器启动成功: ${PORT}`);
});