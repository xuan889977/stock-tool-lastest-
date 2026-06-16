const API_KEY = "d8oo1v1r01qn89hsjcr0d8oo1v1r01qn89hsjcrg";

const params = new URLSearchParams(window.location.search);
const symbol = (params.get("symbol") || "TSLA").toUpperCase();
const tradingViewSymbol = symbol.includes(":") ? symbol : "NASDAQ:" + symbol;

document.getElementById("title").innerText = symbol + " 实时量价分析 V10.1";

new TradingView.widget({
  container_id: "tradingview_chart",
  symbol: tradingViewSymbol,
  interval: "1",
  timezone: "America/New_York",
  theme: "dark",
  style: "1",
  locale: "zh_CN",
  toolbar_bg: "#111827",
  enable_publishing: false,
  allow_symbol_change: true,
  studies: ["Volume@tv-basicstudies"],
  autosize: true
});

let socket = null;

let latestPrice = null;
let previousPrice = null;
let lastTradeTime = null;

let totalVolume = 0;
let secondVolume = 0;
let lastTradeVolume = 0;

let buyPressure = 0;
let sellPressure = 0;

let priceVolumeSum = 0;
let volumeSum = 0;
let vwap = null;

let currentMinute = null;
let minuteOpen = null;
let minuteClose = null;
let minuteHigh = null;
let minuteLow = null;
let minuteVolume = 0;

let finishedMinuteVolumes = [];
let recentPrices = [];
let alertHistory = [];

let pageHigh = null;
let pageLow = null;

const priceLabels = [];
const priceData = [];

const priceChart = new Chart(document.getElementById("priceChart"), {
  type: "line",
  data: {
    labels: priceLabels,
    datasets: [{
      label: "每秒最新成交价",
      data: priceData,
      borderWidth: 2,
      tension: 0.25
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: {
        labels: { color: "#e5e7eb" }
      }
    },
    scales: {
      x: { ticks: { color: "#94a3b8" } },
      y: { ticks: { color: "#94a3b8" } }
    }
  }
});

function fmtPrice(v) {
  if (v === null || v === undefined) return "--";
  return "$" + Number(v).toFixed(2);
}

function fmtNum(v) {
  if (!v && v !== 0) return "--";
  return Math.round(v).toLocaleString();
}

function getTimeText(t) {
  const d = new Date(t);
  return d.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getMinuteKey(t) {
  const d = new Date(t);
  d.setSeconds(0);
  d.setMilliseconds(0);
  return d.getTime();
}

function addAlert(text, type = "neutral") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });

  alertHistory.unshift({ time, text, type });

  if (alertHistory.length > 50) {
    alertHistory.pop();
  }

  document.getElementById("alerts").innerHTML = alertHistory.map(a => {
    const cls = a.type === "good" ? "buy" : a.type === "bad" ? "risk" : "hold";
    return `<div class="alert-row"><span class="${cls}">[${a.time}]</span> ${a.text}</div>`;
  }).join("");
}

function updateVWAP(price, volume) {
  priceVolumeSum += price * volume;
  volumeSum += volume;

  if (volumeSum > 0) {
    vwap = priceVolumeSum / volumeSum;
  }

  document.getElementById("vwap").innerText = fmtPrice(vwap);

  const status = document.getElementById("vwapStatus");

  if (latestPrice > vwap) {
    status.innerText = "价格高于VWAP";
    status.className = "value buy";
  } else if (latestPrice < vwap) {
    status.innerText = "价格低于VWAP";
    status.className = "value risk";
  } else {
    status.innerText = "贴近VWAP";
    status.className = "value hold";
  }
}

function updateMinute(price, volume, timestamp) {
  const key = getMinuteKey(timestamp);

  if (currentMinute === null) {
    currentMinute = key;
    minuteOpen = price;
    minuteClose = price;
    minuteHigh = price;
    minuteLow = price;
    minuteVolume = volume;
    return;
  }

  if (key !== currentMinute) {
    finishedMinuteVolumes.push(minuteVolume);

    if (finishedMinuteVolumes.length > 20) {
      finishedMinuteVolumes.shift();
    }

    currentMinute = key;
    minuteOpen = price;
    minuteClose = price;
    minuteHigh = price;
    minuteLow = price;
    minuteVolume = volume;
  } else {
    minuteClose = price;
    minuteHigh = Math.max(minuteHigh, price);
    minuteLow = Math.min(minuteLow, price);
    minuteVolume += volume;
  }

  document.getElementById("minuteVolume").innerText = fmtNum(minuteVolume);
}

function getVolumeBoost() {
  if (finishedMinuteVolumes.length < 3) return null;

  const avg = finishedMinuteVolumes.reduce((a, b) => a + b, 0) / finishedMinuteVolumes.length;

  if (avg === 0) return null;

  return minuteVolume / avg;
}

function getQuadrant() {
  const boost = getVolumeBoost();
  const priceUp = minuteClose && minuteOpen && minuteClose > minuteOpen;
  const priceDown = minuteClose && minuteOpen && minuteClose < minuteOpen;
  const volumeUp = boost && boost >= 1.2;
  const volumeDown = boost && boost < 1.2;

  if (priceUp && volumeUp) {
    return { text: "量升价涨：健康上涨", type: "buy" };
  }

  if (priceDown && volumeUp) {
    return { text: "量升价跌：危险下跌", type: "risk" };
  }

  if (priceUp && volumeDown) {
    return { text: "量缩价涨：上涨背离", type: "hold" };
  }

  if (priceDown && volumeDown) {
    return { text: "量缩价跌：观望下跌", type: "hold" };
  }

  return { text: "等待形成", type: "hold" };
}

function updateQuadrant() {
  const q = getQuadrant();
  const el = document.getElementById("quadrant");

  el.innerText = q.text;
  el.className = "value " + q.type;
}

function updateRisk() {
  const risk = document.getElementById("riskLevel");

  if (latestPrice && vwap && latestPrice < vwap && sellPressure > buyPressure * 1.3) {
    risk.innerText = "高风险";
    risk.className = "value risk";
    return;
  }

  if (latestPrice && vwap && latestPrice > vwap && buyPressure > sellPressure) {
    risk.innerText = "低风险";
    risk.className = "value buy";
    return;
  }

  risk.innerText = "中等风险";
  risk.className = "value hold";
}

function getSignals() {
  const signals = [];

  if (!latestPrice) {
    return [{ text: "等待实时成交数据", type: "neutral" }];
  }

  const boost = getVolumeBoost();

  if (latestPrice > vwap) {
    signals.push({ text: "价格站上VWAP", type: "good" });
  }

  if (latestPrice < vwap) {
    signals.push({ text: "价格跌破VWAP", type: "bad" });
  }

  if (boost && boost >= 1.8 && minuteClose > minuteOpen) {
    signals.push({ text: "放量上涨", type: "good" });
  }

  if (boost && boost >= 1.8 && minuteClose < minuteOpen) {
    signals.push({ text: "放量下跌", type: "bad" });
  }

  if (buyPressure > sellPressure * 1.3) {
    signals.push({ text: "买盘压力增强", type: "good" });
  }

  if (sellPressure > buyPressure * 1.3) {
    signals.push({ text: "卖盘压力增强", type: "bad" });
  }

  if (signals.length === 0) {
    signals.push({ text: "量价信号中性", type: "neutral" });
  }

  return signals;
}

function updateSignals() {
  const signals = getSignals();

  document.getElementById("signals").innerHTML = signals.map(s => {
    return `<div class="signal ${s.type}">${s.text}</div>`;
  }).join("");
}

function checkEventAlerts() {
  const boost = getVolumeBoost();

  if (!latestPrice || !boost) return;

  if (pageHigh && latestPrice > pageHigh && boost >= 1.5) {
    addAlert(`${symbol} 突破页面高点 + 放量 ${boost.toFixed(2)}x`, "good");
  }

  if (pageLow && latestPrice < pageLow && boost >= 1.5) {
    addAlert(`${symbol} 跌破页面低点 + 放量 ${boost.toFixed(2)}x`, "bad");
  }

  if (pageHigh && latestPrice > pageHigh && boost < 1.0) {
    addAlert(`${symbol} 价格创新高但量能不足，疑似背离`, "neutral");
  }

  if (latestPrice < vwap && sellPressure > buyPressure * 1.5) {
    addAlert(`${symbol} 跌破VWAP且卖盘增强`, "bad");
  }
}

function updateMainSignal() {
  const q = getQuadrant();
  const el = document.getElementById("mainSignal");

  el.innerText = q.text;
  el.className = "advice " + q.type;
}

function updateChart(price, timestamp) {
  priceLabels.push(getTimeText(timestamp));
  priceData.push(price);

  if (priceLabels.length > 60) {
    priceLabels.shift();
    priceData.shift();
  }

  priceChart.update();
}

function handleTrade(trade) {
  const price = trade.p;
  const volume = trade.v;
  const timestamp = trade.t;

  if (!price || !volume || !timestamp) return;

  previousPrice = latestPrice;

  if (latestPrice !== null) {
    if (price > latestPrice) {
      buyPressure += volume;
    } else if (price < latestPrice) {
      sellPressure += volume;
    }
  }

  latestPrice = price;
  lastTradeTime = timestamp;
  lastTradeVolume = volume;

  totalVolume += volume;
  secondVolume += volume;

  if (pageHigh === null || price > pageHigh) pageHigh = price;
  if (pageLow === null || price < pageLow) pageLow = price;

  updateVWAP(price, volume);
  updateMinute(price, volume, timestamp);

  recentPrices.push(price);
  if (recentPrices.length > 100) recentPrices.shift();

  document.getElementById("latestPrice").innerText = fmtPrice(latestPrice);
  document.getElementById("lastTradeTime").innerText = getTimeText(lastTradeTime);
  document.getElementById("totalVolume").innerText = fmtNum(totalVolume);
  document.getElementById("buyPressure").innerText = fmtNum(buyPressure);
  document.getElementById("sellPressure").innerText = fmtNum(sellPressure);

  const boost = getVolumeBoost();
  document.getElementById("volumeBoost").innerText = boost ? boost.toFixed(2) + "x" : "--";

  updateQuadrant();
  updateRisk();
  updateSignals();
  updateMainSignal();
}

function renderEverySecond() {
  if (latestPrice !== null) {
    document.getElementById("price").innerText = fmtPrice(latestPrice);
    document.getElementById("secondVolume").innerText = fmtNum(secondVolume);

    updateChart(latestPrice, Date.now());
    checkEventAlerts();
  }

  secondVolume = 0;
}

function connectWebSocket() {
  document.getElementById("status").innerText = "正在连接实时行情...";

  socket = new WebSocket("wss://ws.finnhub.io?token=" + API_KEY);

  socket.addEventListener("open", () => {
    document.getElementById("status").innerText = "实时行情已连接";
    socket.send(JSON.stringify({
      type: "subscribe",
      symbol
    }));
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);

    if (message.type !== "trade") return;

    message.data.forEach(trade => handleTrade(trade));
  });

  socket.addEventListener("error", () => {
    document.getElementById("status").innerText = "实时连接出错";
  });

  socket.addEventListener("close", () => {
    document.getElementById("status").innerText = "实时连接断开，5秒后重连";
    setTimeout(connectWebSocket, 5000);
  });
}

connectWebSocket();
setInterval(renderEverySecond, 1000);