const homeChartCanvas = document.getElementById("homeTrendChart");

if (homeChartCanvas) {
  const labels = ["09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"];
  const prices = [142.2, 143.4, 142.9, 145.1, 146.2, 145.8, 147.6, 149.1, 150.4];

  new Chart(homeChartCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "NVDA 示例走势",
        data: prices,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34, 197, 94, 0.14)",
        borderWidth: 3,
        pointRadius: 0,
        fill: true,
        tension: 0.38
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { color: "rgba(148, 163, 184, 0.12)" },
          ticks: { color: "#94a3b8" }
        },
        y: {
          grid: { color: "rgba(148, 163, 184, 0.12)" },
          ticks: {
            color: "#94a3b8",
            callback: value => "$" + value
          }
        }
      }
    }
  });
}
