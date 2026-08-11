export class SwingRenderer {
  constructor(priceSeries) {
    this.priceSeries = priceSeries;
    this.markers = LightweightCharts.createSeriesMarkers(priceSeries, []);
  }

  render(swings) {
    this.markers.setMarkers(
      swings.map((swing) => ({
        time: swing.createdAt,
        position: swing.type === "high" ? "aboveBar" : "belowBar",
        color: swing.markerColor ?? (swing.type === "high" ? "#dc2626" : "#16a34a"),
        shape: "circle",
        text: swing.text ?? (swing.type === "high" ? "SH" : "SL"),
      })),
    );
  }
}
