export class CHOCHRenderer {
  constructor({ chart, priceSeries, overlayRoot }) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.overlayRoot = overlayRoot;
    this.nodes = new Map();
    this.items = [];
    this.timeIndex = new Map();
    this.frame = null;
  }

  setTimeline(candles) {
    this.timeIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  }

  render(items) {
    this.items = items;
    const ids = new Set(items.map((item) => item.id));
    for (const [id, node] of this.nodes.entries()) {
      if (!ids.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    for (const item of items) {
      const node = this.nodes.get(item.id) ?? this.createNode("CHOCH");
      this.nodes.set(item.id, node);
      this.positionNode(node, item);
    }
  }

  refresh() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.positionAll();
    });
  }

  positionAll() {
    for (const item of this.items) {
      const node = this.nodes.get(item.id);
      if (node) this.positionNode(node, item);
    }
  }

  createNode(labelText) {
    const node = document.createElement("div");
    node.className = "structure-line choch-line";
    const label = document.createElement("span");
    label.textContent = labelText;
    node.append(label);
    this.overlayRoot.append(node);
    return node;
  }

  positionNode(node, item) {
    const y = this.priceSeries.priceToCoordinate(item.price);
    const left = this.getCoordinate(item.startAt ?? item.createdAt);
    const right = this.getCoordinate(item.endAt ?? item.createdAt);
    if (y === null || left === null || right === null) {
      node.hidden = true;
      return;
    }

    const paneRight = this.getPaneRight();
    const start = Math.min(left, right);
    const end = Math.max(left, right);
    if (end < 0 || start > paneRight) {
      node.hidden = true;
      return;
    }

    const visibleLeft = Math.max(0, start);
    const visibleRight = Math.min(paneRight, end + this.barSpacing() * 2);
    node.hidden = false;
    node.style.left = `${visibleLeft}px`;
    node.style.top = `${y}px`;
    node.style.width = `${Math.max(24, visibleRight - visibleLeft)}px`;
  }

  getCoordinate(time) {
    const coordinate = this.chart.timeScale().timeToCoordinate(time);
    if (coordinate !== null) return coordinate;

    const index = this.timeIndex.get(time);
    const visibleRange = this.chart.timeScale().getVisibleLogicalRange();
    if (index === undefined || !visibleRange) return null;
    return (index - visibleRange.from) * this.barSpacing();
  }

  barSpacing() {
    const options = this.chart.timeScale().options?.();
    return Number(options?.barSpacing ?? 8);
  }

  getPaneRight() {
    return Math.max(0, this.overlayRoot.clientWidth - 124);
  }
}
