export class FVGRenderer {
  constructor({ chart, priceSeries, overlayRoot }) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.overlayRoot = overlayRoot;
    this.nodes = new Map();
    this.fvgs = [];
    this.timeIndex = new Map();
    this.frame = null;
  }

  setTimeline(candles) {
    this.timeIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  }

  render(fvgs) {
    this.fvgs = fvgs;
    const ids = new Set(fvgs.map((fvg) => fvg.id));
    for (const [id, node] of this.nodes.entries()) {
      if (!ids.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    for (const fvg of fvgs) {
      const node = this.nodes.get(fvg.id) ?? this.createNode(fvg);
      this.nodes.set(fvg.id, node);
      this.positionNode(node, fvg);
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
    for (const fvg of this.fvgs) {
      const node = this.nodes.get(fvg.id);
      if (node) this.positionNode(node, fvg);
    }
  }

  createNode(fvg) {
    const node = document.createElement("div");
    node.className = `fvg-box ${fvg.type}`;
    const label = document.createElement("span");
    label.textContent = "FVG";
    node.append(label);
    this.overlayRoot.append(node);
    return node;
  }

  positionNode(node, fvg) {
    const top = this.priceSeries.priceToCoordinate(fvg.top);
    const bottom = this.priceSeries.priceToCoordinate(fvg.bottom);
    const left = this.getCoordinate(fvg.startAt ?? fvg.createdAt);
    if (top === null || bottom === null || left === null) {
      node.hidden = true;
      return;
    }

    const y = Math.min(top, bottom);
    const height = Math.max(2, Math.abs(bottom - top));
    const paneRight = this.getPaneRight();
    const width = this.objectWidth(fvg);
    if (y > this.overlayRoot.clientHeight || y + height < 0 || left > paneRight || left + width < 0) {
      node.hidden = true;
      return;
    }

    const visibleLeft = Math.max(0, left);
    const visibleRight = Math.min(paneRight, left + width);
    if (visibleRight <= visibleLeft) {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    node.className = `fvg-box ${fvg.type}`;
    node.style.top = `${y}px`;
    node.style.left = `${visibleLeft}px`;
    node.style.width = `${visibleRight - visibleLeft}px`;
    node.style.height = `${height}px`;
    node.dataset.status = fvg.status;
  }

  getCoordinate(time) {
    const coordinate = this.chart.timeScale().timeToCoordinate(time);
    if (coordinate !== null) return coordinate;

    const index = this.timeIndex.get(time);
    const visibleRange = this.chart.timeScale().getVisibleLogicalRange();
    if (index === undefined || !visibleRange) return null;
    return (index - visibleRange.from) * this.barSpacing();
  }

  objectWidth(fvg) {
    const bars = Number(fvg.bars ?? 12);
    return Math.max(36, Math.min(this.maxObjectWidth(), bars * this.barSpacing()));
  }

  maxObjectWidth() {
    return 360;
  }

  barSpacing() {
    const options = this.chart.timeScale().options?.();
    return Number(options?.barSpacing ?? 8);
  }

  getPaneRight() {
    return Math.max(0, this.overlayRoot.clientWidth - 124);
  }
}
