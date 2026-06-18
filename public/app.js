const params = new URLSearchParams(window.location.search);
const symbol = (params.get("symbol") || "TSLA").toUpperCase().replace(/[^A-Z0-9:.-]/g, "");
const quoteSymbol = symbol;

document.getElementById("title").innerText = symbol + " 实时量价分析 V10.1";

let latestPrice = null;
let previousPrice = null;
let lastTradeTime = null;

let totalVolume = 0;
let secondVolume = 0;
let lastTradeVolume = 0;
let previousMarketVolume = null;
let pollingTimer = null;
let intradayTimer = null;
let quoteInFlight = false;
let intradayInFlight = false;
let analysisInFlight = false;
let quoteFailCount = 0;
let intradayFailCount = 0;

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
let historicalAnalysis = null;
let analysisTimer = null;
let aiAnalysisTimer = null;
let lastAiRequestAt = 0;

let pageHigh = null;
let pageLow = null;

const priceLabels = [];
const priceData = [];
const historyLabels = [];
const historyCloseData = [];
const historyVolumeData = [];
const intradayLabels = [];
const intradayCloseData = [];
const intradayVolumeData = [];
let intradayPreviousClose = null;
let volumeShapeAverage = null;
let volumeShapePeakIndex = null;
let lastVolumeShapeAnalysis = null;
let lastLocalAiAnalysis = null;

function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, rect.width || canvas.clientWidth || 640);
  const height = Math.max(220, rect.height || canvas.clientHeight || 280);

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  return { ctx, width, height };
}

function drawNoData(ctx, width, height, text) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "14px Arial";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (!res.ok) {
      throw new Error(data.error || data.detail || "请求失败");
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function getVolumePoints() {
  const points = intradayVolumeData.map((volume, index) => ({
    volume,
    close: intradayCloseData[index],
    label: intradayLabels[index],
    index
  })).filter(point => Number.isFinite(point.volume) && Number.isFinite(point.close) && point.volume > 0);

  if (points.length >= 3) return points;

  return intradayVolumeData.map((volume, index) => ({
    volume: Number.isFinite(volume) ? volume : 0,
    close: intradayCloseData[index],
    label: intradayLabels[index],
    index
  })).filter(point => Number.isFinite(point.close));
}

function createPriceChart(canvas) {
  return {
    update() {
      const { ctx, width, height } = prepareCanvas(canvas);

      if (priceData.length < 2) {
        drawNoData(ctx, width, height, "等待实时价格数据...");
        return;
      }

      const padding = 34;
      const values = priceData.filter(v => Number.isFinite(v));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
      ctx.lineWidth = 1;

      for (let i = 0; i < 4; i += 1) {
        const y = padding + ((height - padding * 2) / 3) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      priceData.forEach((value, index) => {
        const x = padding + ((width - padding * 2) / Math.max(priceData.length - 1, 1)) * index;
        const y = height - padding - ((value - min) / span) * (height - padding * 2);

        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Arial";
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(max), 8, padding);
      ctx.fillText(fmtPrice(min), 8, height - padding);
    }
  };
}

function createHistoryChart(canvas) {
  return {
    update() {
      const { ctx, width, height } = prepareCanvas(canvas);

      if (historyCloseData.length < 2) {
        drawNoData(ctx, width, height, "等待历史量价数据...");
        return;
      }

      const padding = 38;
      const prices = historyCloseData.filter(v => Number.isFinite(v));
      const volumes = historyVolumeData.filter(v => Number.isFinite(v));
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const priceSpan = maxPrice - minPrice || 1;
      const maxVolume = Math.max(...volumes, 1);
      const barWidth = Math.max(3, (width - padding * 2) / historyVolumeData.length * 0.55);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i += 1) {
        const y = padding + ((height - padding * 2) / 3) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      historyVolumeData.forEach((volume, index) => {
        const x = padding + ((width - padding * 2) / Math.max(historyVolumeData.length - 1, 1)) * index;
        const barHeight = (volume / maxVolume) * (height - padding * 2) * 0.36;
        ctx.fillStyle = "rgba(34, 197, 94, 0.32)";
        ctx.fillRect(x - barWidth / 2, height - padding - barHeight, barWidth, barHeight);
      });

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      historyCloseData.forEach((value, index) => {
        const x = padding + ((width - padding * 2) / Math.max(historyCloseData.length - 1, 1)) * index;
        const y = height - padding - ((value - minPrice) / priceSpan) * (height - padding * 2);

        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Arial";
      ctx.textAlign = "left";
      ctx.fillText("收盘 " + fmtPrice(maxPrice), 8, padding);
      ctx.fillText("收盘 " + fmtPrice(minPrice), 8, height - padding);
      ctx.textAlign = "right";
      ctx.fillText("成交量", width - 8, padding);
    }
  };
}

function createIntradayChart(canvas) {
  return {
    update() {
      const { ctx, width, height } = prepareCanvas(canvas);

      if (intradayCloseData.length < 2) {
        drawNoData(ctx, width, height, "等待实时分时数据...");
        return;
      }

      const padding = 42;
      const priceTop = padding;
      const priceBottom = Math.round(height * 0.58);
      const volumeTop = Math.round(height * 0.64);
      const volumeBottom = height - padding;
      const prices = intradayCloseData.filter(v => Number.isFinite(v));
      const volumes = intradayVolumeData.filter(v => Number.isFinite(v));
      const refs = intradayPreviousClose ? prices.concat([intradayPreviousClose]) : prices;
      const minPrice = Math.min(...refs);
      const maxPrice = Math.max(...refs);
      const priceSpan = maxPrice - minPrice || 1;
      const maxVolume = Math.max(...volumes, 1);
      const barWidth = Math.max(3, (width - padding * 2) / intradayVolumeData.length * 0.72);
      const priceHeight = priceBottom - priceTop;
      const volumeHeight = volumeBottom - volumeTop;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i += 1) {
        const y = priceTop + (priceHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(148, 163, 184, 0.28)";
      ctx.beginPath();
      ctx.moveTo(padding, volumeTop - 10);
      ctx.lineTo(width - padding, volumeTop - 10);
      ctx.stroke();

      if (intradayPreviousClose) {
        const y = priceBottom - ((intradayPreviousClose - minPrice) / priceSpan) * priceHeight;
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = "rgba(250, 204, 21, 0.7)";
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#facc15";
        ctx.font = "12px Arial";
        ctx.textAlign = "left";
        ctx.fillText("昨收 " + fmtPrice(intradayPreviousClose), padding + 6, y - 6);
      }

      intradayVolumeData.forEach((volume, index) => {
        const x = padding + ((width - padding * 2) / Math.max(intradayVolumeData.length - 1, 1)) * index;
        const barHeight = Math.max(volume > 0 ? 4 : 0, Math.pow(volume / maxVolume, 0.42) * volumeHeight);
        const isUp = index === 0 || intradayCloseData[index] >= intradayCloseData[index - 1];
        ctx.fillStyle = isUp ? "rgba(34, 197, 94, 0.55)" : "rgba(239, 68, 68, 0.55)";
        ctx.fillRect(x - barWidth / 2, volumeBottom - barHeight, barWidth, barHeight);
      });

      const last = intradayCloseData[intradayCloseData.length - 1];
      ctx.strokeStyle = intradayPreviousClose && last < intradayPreviousClose ? "#ef4444" : "#22c55e";
      ctx.lineWidth = 2.6;
      ctx.beginPath();

      intradayCloseData.forEach((value, index) => {
        const x = padding + ((width - padding * 2) / Math.max(intradayCloseData.length - 1, 1)) * index;
        const y = priceBottom - ((value - minPrice) / priceSpan) * priceHeight;

        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });

      ctx.stroke();
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Arial";
      ctx.textAlign = "left";
      ctx.fillText("高 " + fmtPrice(maxPrice), 8, padding);
      ctx.fillText("低 " + fmtPrice(minPrice), 8, priceBottom);
      ctx.fillText("成交量峰值 " + fmtNum(maxVolume), 8, volumeTop);
      ctx.textAlign = "right";
      ctx.fillText(intradayLabels[0] || "", width - padding, height - 10);
      ctx.fillText(intradayLabels[intradayLabels.length - 1] || "", width - 8, padding);
    }
  };
}

function createVolumeShapeChart(canvas) {
  return {
    update() {
      const { ctx, width, height } = prepareCanvas(canvas);

      const points = getVolumePoints();

      if (points.length < 3) {
        drawNoData(ctx, width, height, "等待分时成交量形态...");
        return;
      }

      const padding = 34;
      const volumes = points.map(point => point.volume);
      const maxVolume = Math.max(...volumes, 1);
      const avg = volumeShapeAverage || (volumes.reduce((a, b) => a + b, 0) / volumes.length);
      const chartHeight = height - padding * 2;
      const barWidth = Math.max(4, (width - padding * 2) / points.length * 0.76);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#020617";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(148, 163, 184, 0.16)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i += 1) {
        const y = padding + (chartHeight / 3) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      const avgY = height - padding - Math.pow(avg / maxVolume, 0.42) * chartHeight;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(250, 204, 21, 0.72)";
      ctx.beginPath();
      ctx.moveTo(padding, avgY);
      ctx.lineTo(width - padding, avgY);
      ctx.stroke();
      ctx.setLineDash([]);

      points.forEach((point, pointIndex) => {
        const x = padding + ((width - padding * 2) / Math.max(points.length - 1, 1)) * pointIndex;
        const barHeight = Math.max(5, Math.pow(point.volume / maxVolume, 0.42) * chartHeight);
        const previousPoint = points[Math.max(0, pointIndex - 1)];
        const priceUp = pointIndex === 0 || point.close >= previousPoint.close;
        const isPeak = point.index === volumeShapePeakIndex;

        if (isPeak) {
          ctx.fillStyle = "#facc15";
        } else if (point.volume >= avg * 1.8) {
          ctx.fillStyle = priceUp ? "rgba(34, 197, 94, 0.88)" : "rgba(239, 68, 68, 0.88)";
        } else {
          ctx.fillStyle = priceUp ? "rgba(34, 197, 94, 0.45)" : "rgba(239, 68, 68, 0.45)";
        }

        ctx.fillRect(x - barWidth / 2, height - padding - barHeight, barWidth, barHeight);
      });

      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Arial";
      ctx.textAlign = "left";
      ctx.fillText("均量 " + fmtNum(avg), padding, Math.max(14, avgY - 8));
      ctx.fillText("峰值 " + fmtNum(maxVolume), 8, padding);
      ctx.textAlign = "right";
      const peakPoint = points.find(point => point.index === volumeShapePeakIndex);
      if (peakPoint) {
        ctx.fillStyle = "#facc15";
        ctx.fillText("峰值 " + (peakPoint.label || ""), width - 8, padding);
      }
      ctx.fillStyle = "#94a3b8";
      ctx.fillText("有效量柱 " + points.length + " 根", width - 8, padding + 18);
      ctx.fillText(points[points.length - 1].label || "", width - 8, height - 10);
    }
  };
}

const priceChart = createPriceChart(document.getElementById("priceChart"));
const historyChart = createHistoryChart(document.getElementById("historyChart"));
const intradayChart = createIntradayChart(document.getElementById("intradayChart"));
const volumeShapeChart = createVolumeShapeChart(document.getElementById("volumeShapeChart"));

window.addEventListener("resize", () => {
  priceChart.update();
  historyChart.update();
  intradayChart.update();
  volumeShapeChart.update();
});

function fmtPrice(v) {
  if (v === null || v === undefined) return "--";
  return "$" + Number(v).toFixed(2);
}

function fmtPercent(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
  const n = Number(v);
  return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
}

function fmtRatio(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
  return Number(v).toFixed(2) + "x";
}

function fmtNum(v) {
  if (!v && v !== 0) return "--";
  return Math.round(v).toLocaleString();
}

function average(values) {
  const valid = values.filter(value => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
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

function renderSignals(targetId, signals) {
  document.getElementById(targetId).innerHTML = signals.map(s => {
    return `<div class="signal ${s.type}">${s.text}</div>`;
  }).join("");
}

function getBeginnerGuide(analysis) {
  const match = analysis.match;
  const trend = analysis.trend;
  const type = analysis.type;

  if (match === "价涨量增") {
    return {
      note: "价格上涨时成交量也增加，说明上涨有人参与，短线结构相对健康。",
      decision: "偏推荐观察",
      type: "buy",
      action: "可以加入观察列表，等回踩不破VWAP或再次放量时再考虑。",
      risk: "追高风险"
    };
  }

  if (match === "价涨量缩") {
    return {
      note: "价格在涨，但成交量没有跟上，容易是假突破或上涨乏力。",
      decision: "不建议追高",
      type: "hold",
      action: "先等下一波量柱确认，只有放量继续上攻才更可靠。",
      risk: "上涨背离"
    };
  }

  if (match === "价跌量增") {
    return {
      note: "价格下跌时成交量放大，通常代表卖压增强，新手要先控制风险。",
      decision: "暂不推荐",
      type: "risk",
      action: "不要急着抄底，等卖压变弱、价格重新站回VWAP再看。",
      risk: "放量下跌"
    };
  }

  if (match === "价跌量缩") {
    return {
      note: "价格回落但成交量变小，说明恐慌不强，但也还没有明确转强。",
      decision: "谨慎观察",
      type: "hold",
      action: "等待止跌和买盘恢复，不急着出手。",
      risk: "趋势不明"
    };
  }

  if (trend === "量能递增" || type === "持续放量") {
    return {
      note: "成交量正在变活跃，说明市场关注度上升，但还要看价格方向。",
      decision: "重点观察",
      type: "buy",
      action: "观察价格是否能同步走强，避免只放量不涨。",
      risk: "冲高回落"
    };
  }

  if (trend === "量能衰减" || type === "缩量窄幅") {
    return {
      note: "成交量在下降，说明参与度变弱，短线爆发力不足。",
      decision: "耐心等待",
      type: "hold",
      action: "等成交量重新放大后再判断方向。",
      risk: "流动性不足"
    };
  }

  return {
    note: "当前量价结构偏中性，暂时没有明显的买入或卖出信号。",
    decision: "中性观望",
    type: "hold",
    action: "继续盯盘，等价格和成交量给出更清楚的方向。",
    risk: "信号不足"
  };
}

function buildAiAnalysis(volumeAnalysis) {
  const guide = getBeginnerGuide(volumeAnalysis);
  const reasons = [];
  let score = 50;

  if (guide.type === "buy") score += 16;
  if (guide.type === "risk") score -= 22;
  if (volumeAnalysis.trend === "量能递增") score += 8;
  if (volumeAnalysis.trend === "量能衰减") score -= 8;
  if (volumeAnalysis.type === "持续放量") score += 8;
  if (volumeAnalysis.type === "脉冲放量") score -= 4;

  reasons.push({ text: `分时结论：${volumeAnalysis.match}，${guide.note}`, type: guide.type === "risk" ? "bad" : guide.type === "buy" ? "good" : "neutral" });

  if (historicalAnalysis && historicalAnalysis.rating) {
    const rating = historicalAnalysis.rating;
    if (rating.type === "buy") score += 12;
    if (rating.type === "risk") score -= 14;
    reasons.push({ text: `历史量价：${rating.text}`, type: rating.type === "risk" ? "bad" : rating.type === "buy" ? "good" : "neutral" });
  }

  if (latestPrice && vwap) {
    if (latestPrice > vwap) {
      score += 8;
      reasons.push({ text: "价格站在VWAP上方，盘中均价支撑较好", type: "good" });
    } else {
      score -= 8;
      reasons.push({ text: "价格低于VWAP，盘中承压更明显", type: "bad" });
    }
  }

  if (buyPressure > sellPressure * 1.3) {
    score += 8;
    reasons.push({ text: "买盘压力强于卖盘", type: "good" });
  } else if (sellPressure > buyPressure * 1.3) {
    score -= 10;
    reasons.push({ text: "卖盘压力强于买盘", type: "bad" });
  }

  score = Math.max(0, Math.min(100, score));

  let recommendation = "中性观察";
  let type = "hold";
  let confidence = "中";

  if (score >= 70) {
    recommendation = "偏推荐盯盘";
    type = "buy";
    confidence = score >= 82 ? "高" : "中高";
  } else if (score <= 38) {
    recommendation = "暂不推荐";
    type = "risk";
    confidence = score <= 25 ? "高" : "中高";
  }

  if (reasons.length < 3) {
    confidence = "低";
    reasons.push({ text: "实时样本仍在积累，结论需要继续确认", type: "neutral" });
  }

  return {
    guide,
    recommendation,
    type,
    score,
    confidence,
    action: guide.action,
    risk: guide.risk,
    summary: `${recommendation}。当前核心依据是${volumeAnalysis.match}和${volumeAnalysis.trend}，新手不要只看涨跌，要同时看成交量是否配合。`,
    reasons: reasons.slice(0, 5)
  };
}

function renderAiResult(ai) {
  const sourceText = ai.source === "openai"
    ? `强模型分析 · ${ai.model || "OpenAI"}`
    : `大盘增强分析 · ${ai.model || "规则模型"}`;

  document.getElementById("beginnerNote").innerText = ai.beginnerNote || ai.guide?.note || "--";
  document.getElementById("beginnerDecision").innerText = ai.decision || ai.guide?.decision || "--";
  document.getElementById("beginnerDecision").className = "value " + (ai.type || ai.guide?.type || "hold");
  document.getElementById("aiRecommendation").innerText = ai.recommendation || "中性观察";
  document.getElementById("aiRecommendation").className = "ai-recommendation " + (ai.type || "hold");
  document.getElementById("aiSummaryText").innerText = ai.summary || "等待AI综合分析...";
  document.getElementById("aiConfidence").innerText = `${ai.confidence || "中"} · ${Math.round(ai.score || 50)}分`;
  document.getElementById("aiRisk").innerText = ai.risk || "--";
  document.getElementById("aiRisk").className = "value " + (ai.type === "risk" ? "risk" : "hold");
  document.getElementById("aiActionPlan").innerText = ai.action || "继续观察量价与大盘是否共振。";
  document.getElementById("aiStatus").innerText = sourceText;
  renderSignals("aiReasonList", ai.reasons || [{ text: "等待AI分析...", type: "neutral" }]);
}

function getLiveAiMetrics() {
  return {
    latestPrice,
    vwap,
    buyPressure,
    sellPressure,
    minuteOpen,
    minuteClose,
    minuteVolume,
    volumeBoost: getVolumeBoost(),
    pageHigh,
    pageLow
  };
}

async function fetchModelAiAnalysis(force = false) {
  if (!lastVolumeShapeAnalysis || lastVolumeShapeAnalysis.match === "--") return;

  const now = Date.now();
  if (!force && now - lastAiRequestAt < 45000) return;

  lastAiRequestAt = now;
  document.getElementById("aiStatus").innerText = "正在结合大盘和AI模型分析...";

  try {
    const data = await fetchJson(`/api/ai-analysis/${encodeURIComponent(quoteSymbol)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        volumeAnalysis: lastVolumeShapeAnalysis,
        liveMetrics: getLiveAiMetrics(),
        localRule: lastLocalAiAnalysis
      })
    }, 20000);

    renderAiResult(data);
  } catch (err) {
    document.getElementById("aiStatus").innerText = `AI模型暂不可用，已使用本地分析：${err.message}`;
  }
}

function updateAiPanel(volumeAnalysis) {
  const ai = buildAiAnalysis(volumeAnalysis);
  lastLocalAiAnalysis = ai;

  renderAiResult({
    ...ai,
    beginnerNote: ai.guide.note,
    decision: ai.guide.decision,
    source: "local",
    model: "本地实时规则"
  });
  fetchModelAiAnalysis();
}

function updateTape(quote) {
  document.getElementById("openPrice").innerText = fmtPrice(quote.open);
  document.getElementById("previousClose").innerText = fmtPrice(quote.previousClose);
  document.getElementById("dayHigh").innerText = fmtPrice(quote.dayHigh);
  document.getElementById("dayLow").innerText = fmtPrice(quote.dayLow);
  document.getElementById("bidPrice").innerText = quote.bid ? `${fmtPrice(quote.bid)} x ${fmtNum(quote.bidSize)}` : "--";
  document.getElementById("askPrice").innerText = quote.ask ? `${fmtPrice(quote.ask)} x ${fmtNum(quote.askSize)}` : "--";
  document.getElementById("changePercent").innerText = fmtPercent(quote.changePercent);
  document.getElementById("changePercent").className = quote.changePercent > 0 ? "buy" : quote.changePercent < 0 ? "risk" : "hold";
  document.getElementById("marketState").innerText = quote.marketState || "--";
}

function updateLiveHistoryRatio(marketVolume) {
  if (historicalAnalysis && historicalAnalysis.metrics && historicalAnalysis.metrics.avgVolume20) {
    document.getElementById("volumeRatio20").innerText = fmtRatio(marketVolume / historicalAnalysis.metrics.avgVolume20);
  }
}

function updateHistoryChart(history) {
  historyLabels.length = 0;
  historyCloseData.length = 0;
  historyVolumeData.length = 0;

  history.forEach(row => {
    const d = new Date(row.date);
    historyLabels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    historyCloseData.push(row.close);
    historyVolumeData.push(row.volume);
  });

  historyChart.update();
}

function updateIntradayChart(data) {
  intradayLabels.length = 0;
  intradayCloseData.length = 0;
  intradayVolumeData.length = 0;
  intradayPreviousClose = data.previousClose || null;

  (data.points || []).forEach(point => {
    const d = new Date(point.time);
    intradayLabels.push(d.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    }));
    intradayCloseData.push(point.close);
    intradayVolumeData.push(point.volume || 0);
  });

  document.getElementById("intradayStatus").innerText = `${data.symbol} · ${data.marketState} · ${data.source || "yahoo"} · ${intradayLabels.length}点`;
  intradayChart.update();
  updateVolumeShapeAnalysis();
}

function getVolumeShapeAnalysis() {
  const points = getVolumePoints();
  const volumes = points.map(point => point.volume);
  const closes = points.map(point => point.close);

  if (volumes.length < 8 || closes.length < 8) {
    volumeShapeAverage = null;
    volumeShapePeakIndex = null;

    return {
      type: "等待形成",
      trend: "--",
      match: "--",
      peakTime: "--",
      typeClass: "hold",
      signals: [{ text: "等待更多分时成交量数据", type: "neutral" }]
    };
  }

  const total = volumes.reduce((a, b) => a + b, 0);
  const avg = total / volumes.length;
  const peak = Math.max(...volumes);
  const peakPointIndex = volumes.indexOf(peak);
  const peakIndex = points[peakPointIndex].index;
  const firstWindow = volumes.slice(0, Math.max(3, Math.floor(volumes.length * 0.25)));
  const recentWindow = volumes.slice(-Math.max(3, Math.floor(volumes.length * 0.25)));
  const firstAvg = average(firstWindow);
  const recentAvg = average(recentWindow);
  const volumeTrendRatio = firstAvg ? recentAvg / firstAvg : null;
  const priceChange = closes[closes.length - 1] - closes[0];
  const recentPriceChange = closes[closes.length - 1] - closes[Math.max(0, closes.length - recentWindow.length)];
  const peakRatio = avg ? peak / avg : null;
  const aboveAvgCount = volumes.filter(volume => volume > avg * 1.2).length;
  const aboveAvgRatio = aboveAvgCount / volumes.length;
  const peakTime = points[peakPointIndex].label || "--";
  const signals = [];

  let type = "均衡量能";
  let trend = "量能平稳";
  let match = "价量中性";
  let typeClass = "hold";

  if (peakRatio && peakRatio >= 4 && aboveAvgRatio < 0.18) {
    type = "脉冲放量";
    signals.push({ text: "出现单点或少数峰值量柱，适合结合价格位置判断是否是假突破", type: "neutral" });
  } else if (aboveAvgRatio >= 0.35) {
    type = "持续放量";
    signals.push({ text: "多段成交量高于均量，盘中参与度明显提升", type: "good" });
  } else if (aboveAvgRatio <= 0.12 && peakRatio && peakRatio < 2) {
    type = "缩量窄幅";
    signals.push({ text: "成交量柱整体偏低，趋势确认度不足", type: "neutral" });
  }

  if (volumeTrendRatio !== null && volumeTrendRatio >= 1.35) {
    trend = "量能递增";
    signals.push({ text: "后段量能大于前段，资金活跃度在增强", type: "good" });
  } else if (volumeTrendRatio !== null && volumeTrendRatio <= 0.72) {
    trend = "量能衰减";
    signals.push({ text: "后段量能低于前段，追价力量在减弱", type: "bad" });
  }

  if (priceChange > 0 && volumeTrendRatio !== null && volumeTrendRatio >= 1.1) {
    match = "价涨量增";
    typeClass = "buy";
    signals.push({ text: "价格上涨且量能配合，短线结构偏强", type: "good" });
  } else if (priceChange > 0 && volumeTrendRatio !== null && volumeTrendRatio < 0.85) {
    match = "价涨量缩";
    typeClass = "hold";
    signals.push({ text: "价格上涨但量能跟不上，注意背离", type: "neutral" });
  } else if (priceChange < 0 && volumeTrendRatio !== null && volumeTrendRatio >= 1.1) {
    match = "价跌量增";
    typeClass = "risk";
    signals.push({ text: "价格下跌且量能放大，卖压偏强", type: "bad" });
  } else if (priceChange < 0 && volumeTrendRatio !== null && volumeTrendRatio < 0.85) {
    match = "价跌量缩";
    typeClass = "hold";
    signals.push({ text: "价格回落但量能收缩，恐慌程度有限", type: "neutral" });
  }

  if (recentPriceChange > 0 && recentAvg > avg * 1.3) {
    signals.push({ text: "最近一段出现带量上攻", type: "good" });
  }

  if (recentPriceChange < 0 && recentAvg > avg * 1.3) {
    signals.push({ text: "最近一段出现带量回落", type: "bad" });
  }

  if (!signals.length) {
    signals.push({ text: "量能形态暂时中性，等待新的量柱确认", type: "neutral" });
  }

  volumeShapeAverage = avg;
  volumeShapePeakIndex = peakIndex;

  return {
    type,
    trend,
    match,
    peakTime,
    typeClass,
    signals
  };
}

function updateVolumeShapeAnalysis() {
  const analysis = getVolumeShapeAnalysis();
  lastVolumeShapeAnalysis = analysis;

  document.getElementById("volumeShapeType").innerText = analysis.type;
  document.getElementById("volumeShapeType").className = "value " + analysis.typeClass;
  document.getElementById("volumePeakTime").innerText = analysis.peakTime;
  document.getElementById("volumeTrend").innerText = analysis.trend;
  document.getElementById("priceVolumeMatch").innerText = analysis.match;
  document.getElementById("priceVolumeMatch").className = "value " + analysis.typeClass;
  document.getElementById("volumeShapeStatus").innerText = volumeShapeAverage
    ? `有效量柱均量 ${fmtNum(volumeShapeAverage)} · 峰值 ${analysis.peakTime}`
    : "等待有效成交量柱...";
  renderSignals("volumeShapeSignals", analysis.signals);
  volumeShapeChart.update();

  if (analysis.match !== "--") {
    updateAiPanel(analysis);
  }
}

function updateHistoryAnalysis(analysis) {
  historicalAnalysis = analysis;

  const metrics = analysis.metrics || {};
  const rating = analysis.rating || { text: "持有观察", type: "hold" };

  document.getElementById("historyRating").innerText = rating.text;
  document.getElementById("historyRating").className = "advice " + rating.type;
  document.getElementById("avgVolume5").innerText = fmtNum(metrics.avgVolume5);
  document.getElementById("avgVolume20").innerText = fmtNum(metrics.avgVolume20);
  document.getElementById("volumeRatio20").innerText = fmtRatio(metrics.volumeRatio20);
  document.getElementById("high20").innerText = fmtPrice(metrics.high20);
  document.getElementById("low20").innerText = fmtPrice(metrics.low20);
  document.getElementById("change5Day").innerText = fmtPercent(metrics.change5Day);
  document.getElementById("change20Day").innerText = fmtPercent(metrics.change20Day);
  document.getElementById("latestClose").innerText = fmtPrice(metrics.latestClose);

  renderSignals("historySignals", analysis.signals || [{ text: "历史量价中性", type: "neutral" }]);

  if (analysis.history) {
    updateHistoryChart(analysis.history);
  }

  if (analysis.quote) {
    updateTape(analysis.quote);
  }

  if (lastVolumeShapeAnalysis && lastVolumeShapeAnalysis.match !== "--") {
    updateAiPanel(lastVolumeShapeAnalysis);
  }
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

function handleQuote(quote) {
  const price = Number(quote.price);
  const marketVolume = Number(quote.volume || 0);
  const timestamp = new Date(quote.time || Date.now()).getTime();

  if (!price || !timestamp) return;

  updateTape(quote);
  updateLiveHistoryRatio(marketVolume);

  let volume = 0;

  if (previousMarketVolume === null) {
    volume = marketVolume || 1;
  } else {
    volume = Math.max(marketVolume - previousMarketVolume, 0);
  }

  previousMarketVolume = marketVolume;

  if (volume === 0 && latestPrice !== null && price !== latestPrice) {
    volume = 1;
  }

  if (volume === 0) {
    document.getElementById("status").innerText = `${quote.symbol} 行情已更新 · ${quote.marketState} · ${quote.source || "yahoo"}`;
    latestPrice = price;
    lastTradeTime = timestamp;
    document.getElementById("latestPrice").innerText = fmtPrice(latestPrice);
    document.getElementById("lastTradeTime").innerText = getTimeText(lastTradeTime);
    return;
  }

  handleTrade({
    p: price,
    v: volume,
    t: timestamp
  });

  document.getElementById("status").innerText = `${quote.symbol} 行情已更新 · ${quote.marketState} · ${quote.source || "yahoo"}`;
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

async function fetchQuote() {
  if (quoteInFlight) return;
  quoteInFlight = true;

  try {
    const data = await fetchJson(`/api/quote/${encodeURIComponent(quoteSymbol)}`, {}, 10000);
    quoteFailCount = 0;
    handleQuote(data);

    if (data.stale) {
      document.getElementById("status").innerText = `${data.symbol} 行情源短暂波动，正在显示最近可用数据`;
    }
  } catch (err) {
    quoteFailCount += 1;

    if (latestPrice !== null) {
      document.getElementById("status").innerText = `${quoteSymbol} 行情短暂中断，保留上次价格并自动重试`;
      if (quoteFailCount === 3 || quoteFailCount % 10 === 0) {
        addAlert(`${quoteSymbol} 行情源不稳定，已保留上次数据：${err.message}`, "neutral");
      }
    } else {
      document.getElementById("status").innerText = "正在唤醒服务和连接行情源，请稍候...";
      if (quoteFailCount === 3 || quoteFailCount % 10 === 0) {
        addAlert(`${quoteSymbol} 首次行情连接较慢：${err.message}`, "neutral");
      }
    }
  } finally {
    quoteInFlight = false;
  }
}

async function fetchAnalysis() {
  if (analysisInFlight) return;
  analysisInFlight = true;

  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(quoteSymbol)}`, {}, 18000);
    updateHistoryAnalysis(data);
  } catch (err) {
    if (!historicalAnalysis) {
      document.getElementById("historyRating").innerText = "历史量价连接中";
      document.getElementById("historyRating").className = "advice hold";
      renderSignals("historySignals", [{ text: "历史数据源较慢，正在自动重试", type: "neutral" }]);
    }
  } finally {
    analysisInFlight = false;
  }
}

async function fetchIntraday() {
  if (intradayInFlight) return;
  intradayInFlight = true;

  try {
    const data = await fetchJson(`/api/intraday/${encodeURIComponent(quoteSymbol)}`, {}, 16000);
    intradayFailCount = 0;
    updateIntradayChart(data);

    if (data.stale) {
      document.getElementById("intradayStatus").innerText = `${data.symbol} · 显示最近可用分时数据`;
    }
  } catch (err) {
    intradayFailCount += 1;
    document.getElementById("intradayStatus").innerText = intradayCloseData.length
      ? "分时源短暂中断，保留当前图表并自动重试"
      : "正在连接分时数据源，请稍候...";

    if (intradayFailCount === 3 || intradayFailCount % 10 === 0) {
      addAlert(`${quoteSymbol} 分时数据源不稳定：${err.message}`, "neutral");
    }
  } finally {
    intradayInFlight = false;
  }
}

function startQuotePolling() {
  document.getElementById("status").innerText = "正在获取实时盯盘行情...";
  fetchIntraday();
  fetchAnalysis();
  fetchQuote();
  pollingTimer = setInterval(fetchQuote, 5000);
  intradayTimer = setInterval(fetchIntraday, 12000);
  analysisTimer = setInterval(fetchAnalysis, 90000);
  aiAnalysisTimer = setInterval(() => fetchModelAiAnalysis(true), 90000);
}

startQuotePolling();
setInterval(renderEverySecond, 1000);
