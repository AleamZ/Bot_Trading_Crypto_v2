export type Direction = "bullish" | "bearish";

export function oppositeDirection(direction: Direction): Direction {
  return direction === "bullish" ? "bearish" : "bullish";
}
