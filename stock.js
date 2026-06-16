const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance();

async function getStock() {
  try {
    const symbol = process.argv[2] || "NVDA";
    const quote = await yahooFinance.quote(symbol);

    console.log("股票:", quote.symbol);
    console.log("名称:", quote.shortName);
    console.log("价格:", quote.regularMarketPrice);
    console.log("涨跌:", quote.regularMarketChangePercent + "%");
    console.log("成交量:", quote.regularMarketVolume);

    if (quote.regularMarketChangePercent > 0) {
      console.log("趋势: 上涨 📈");
    } else {
      console.log("趋势: 下跌 📉");
    }

    let score = 50;

    if (quote.regularMarketChangePercent > 0) {
      score = score + 20;
    } else {
      score = score - 20;
    }

    if (quote.regularMarketVolume > 30000000) {
      score = score + 10;
    }

    console.log("量价评分:", score);
    if (score >= 80) {
  console.log("建议: BUY 买入观察");
} else if (score >= 60) {
  console.log("建议: HOLD 持有观察");
} else {
  console.log("建议: RISK 风险较高");
}

  } catch (err) {
    console.error("获取股票数据失败:", err.message);
  }
}

getStock();