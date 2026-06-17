const homeChartCanvas = document.getElementById("homeTrendChart");

if (homeChartCanvas) {
  const labels = ["09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"];
  const prices = [142.2, 143.4, 142.9, 145.1, 146.2, 145.8, 147.6, 149.1, 150.4];

  function drawHomeChart() {
    const rect = homeChartCanvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(320, rect.width || 520);
    const height = Math.max(220, rect.height || 320);
    const padding = 34;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;

    homeChartCanvas.width = Math.round(width * ratio);
    homeChartCanvas.height = Math.round(height * ratio);

    const ctx = homeChartCanvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i += 1) {
      const y = padding + ((height - padding * 2) / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(width - padding, y);
      ctx.stroke();
    }

    ctx.beginPath();
    prices.forEach((price, index) => {
      const x = padding + ((width - padding * 2) / Math.max(prices.length - 1, 1)) * index;
      const y = height - padding - ((price - min) / span) * (height - padding * 2);

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px Arial";
    ctx.textAlign = "left";
    ctx.fillText("$" + max.toFixed(2), 8, padding);
    ctx.fillText(labels[0], padding, height - 10);
    ctx.textAlign = "right";
    ctx.fillText(labels[labels.length - 1], width - padding, height - 10);
  }

  drawHomeChart();
  window.addEventListener("resize", drawHomeChart);
}
