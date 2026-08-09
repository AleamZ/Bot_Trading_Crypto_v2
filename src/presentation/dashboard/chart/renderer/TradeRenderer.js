export class TradeRenderer {
  constructor(priceSeries) {
    this.priceSeries = priceSeries;
  }

  render(trades) {
    return trades.map((trade) => ({
      time: trade.createdAt,
      position: trade.type === "entry" ? "belowBar" : "aboveBar",
      color: trade.type === "entry" ? "#16a34a" : "#dc2626",
      shape: trade.type === "entry" ? "arrowUp" : "arrowDown",
      text: trade.type.toUpperCase(),
    }));
  }
}
