export class CandleRenderer {
  constructor(chart) {
    this.candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#dc2626",
      borderUpColor: "#16a34a",
      borderDownColor: "#dc2626",
      wickUpColor: "#16a34a",
      wickDownColor: "#dc2626",
    });
    this.volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    this.volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
  }

  render(candles) {
    this.candleSeries.setData(
      candles.map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );
    this.volumeSeries.setData(
      candles.map((candle) => ({
        time: candle.time,
        value: candle.volume,
        color: candle.close >= candle.open ? "rgba(22, 163, 74, 0.28)" : "rgba(220, 38, 38, 0.28)",
      })),
    );
  }
}
