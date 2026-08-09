export class EMARenderer {
  constructor(chart) {
    this.series = chart.addSeries(LightweightCharts.LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: "EMA",
    });
  }

  render(ema) {
    const period = ema.find((point) => point.period)?.period;
    this.series.applyOptions({ title: period ? `EMA ${period}` : "EMA" });
    this.series.setData(
      ema.map((point) => ({
        time: point.time,
        value: point.value,
      })),
    );
  }
}
