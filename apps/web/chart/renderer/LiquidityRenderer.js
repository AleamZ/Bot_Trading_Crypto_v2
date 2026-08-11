const DEFAULT_DEBUG = {
  showHistoricalLiquidity: false,
  showInternalLiquidity: false,
  showLiquidityNodes: false,
  showLiquidityConnections: false,
  showSweepHistory: false,
};

export class LiquidityRenderer {
  constructor({ chart, priceSeries, overlayRoot, debug = null }) {
    this.chart = chart;
    this.priceSeries = priceSeries;
    this.overlayRoot = overlayRoot;
    this.nodes = new Map();
    this.levels = [];
    this.rawLevels = [];
    this.levelById = new Map();
    this.timeIndex = new Map();
    this.frame = null;
    this.debug = {
      ...DEFAULT_DEBUG,
      ...(window.SMC_LIQUIDITY_DEBUG ?? {}),
      ...(debug ?? {}),
    };
  }

  setTimeline(candles) {
    this.timeIndex = new Map(candles.map((candle, index) => [candle.time, index]));
  }

  render(levels) {
    this.rawLevels = levels;
    this.levelById = new Map(levels.filter((level) => level.kind !== "sweep").map((level) => [level.id, level]));
    this.levels = this.selectVisibleLevels(levels);

    const ids = new Set(this.levels.map((level) => level.id));
    for (const [id, node] of this.nodes.entries()) {
      if (!ids.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    for (const level of this.levels) {
      const node = this.nodes.get(level.id) ?? this.createNode(level);
      this.nodes.set(level.id, node);
      this.positionNode(node, level);
    }
  }

  visibleCount() {
    return this.levels.length;
  }

  selectVisibleLevels(levels) {
    const levelObjects = levels.filter((level) => level.kind !== "sweep");
    const sweepObjects = levels.filter((level) => level.kind === "sweep");

    if (this.debug.showHistoricalLiquidity) {
      return this.filterInternal([...levelObjects, ...this.selectSweeps(sweepObjects)]);
    }

    const visible = [];
    for (const type of ["BSL", "SSL"]) {
      const active = this.filterInternal(
        levelObjects
          .filter((level) => level.type === type && !level.swept)
          .sort((a, b) => Number(a.candleIndex ?? 0) - Number(b.candleIndex ?? 0)),
      );
      const primary = active.find((level) => level.isPrimary);
      if (!primary) continue;

      visible.push(primary);

      if (this.debug.showLiquidityNodes || this.debug.showLiquidityConnections) {
        const secondary = active.find((level) => level.id !== primary.id && (level.parentId === primary.id || primary.children?.includes(level.id)));
        if (secondary) visible.push({ ...secondary, isVisibleSecondary: true });
      }
    }

    return [...visible, ...this.selectSweeps(sweepObjects)];
  }

  filterInternal(levels) {
    if (this.debug.showInternalLiquidity) return levels;
    return levels.filter((level) => !level.isInternal);
  }

  selectSweeps(sweeps) {
    if (!this.debug.showSweepHistory) return [];
    const latestByType = new Map();
    for (const sweep of sweeps) {
      const current = latestByType.get(sweep.type);
      if (!current || Number(sweep.candleIndex ?? 0) > Number(current.candleIndex ?? 0)) {
        latestByType.set(sweep.type, sweep);
      }
    }
    return [...latestByType.values()];
  }

  refresh() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.positionAll();
    });
  }

  positionAll() {
    for (const level of this.levels) {
      const node = this.nodes.get(level.id);
      if (node) this.positionNode(node, level);
    }
  }

  createNode(level) {
    const node = document.createElement("div");
    if (level.kind === "sweep") {
      node.className = `liquidity-sweep ${level.type}`;
      node.textContent = level.direction === "down" ? "▼" : "▲";
    } else {
      node.className = this.className(level);
      node.innerHTML = `
        <svg class="liquidity-diagonal" aria-hidden="true"></svg>
        <div class="liquidity-node" aria-hidden="true"></div>
        <div class="liquidity-horizontal"><span class="liquidity-x">X</span><span class="liquidity-label">${level.type}</span></div>
      `;
    }
    this.overlayRoot.append(node);
    return node;
  }

  positionNode(node, level) {
    if (level.kind === "sweep") {
      this.positionSweep(node, level);
      return;
    }

    const y = this.priceSeries.priceToCoordinate(level.price);
    const left = this.getCoordinate(level.createdAt);
    if (y === null || left === null) {
      node.hidden = true;
      return;
    }

    const paneRight = this.getPaneRight();
    const width = this.objectWidth(level);
    if (left > paneRight || left + width < 0) {
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
    node.className = this.className(level);
    node.style.left = `${visibleLeft}px`;
    node.style.top = "0px";
    node.style.width = `${visibleRight - visibleLeft}px`;
    node.style.height = `${this.overlayRoot.clientHeight}px`;

    this.positionHorizontal(node, level, y);
    this.positionDiagonal(node, level, visibleLeft, visibleRight);
    this.positionLiquidityNode(node, level, visibleLeft);
  }

  positionSweep(node, sweep) {
    const y = this.priceSeries.priceToCoordinate(sweep.price);
    const x = this.getCoordinate(sweep.createdAt);
    if (x === null || y === null) {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    node.className = `liquidity-sweep ${sweep.type}`;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  }

  positionHorizontal(node, level, y) {
    const horizontal = node.querySelector(".liquidity-horizontal");
    const label = node.querySelector(".liquidity-label");
    const x = node.querySelector(".liquidity-x");
    label.textContent = level.type;
    horizontal.style.top = `${y}px`;
    horizontal.hidden = !level.isPrimary && !level.swept;
    label.hidden = !level.isPrimary;
    x.hidden = !level.swept;
  }

  positionDiagonal(node, level, visibleLeft, visibleRight) {
    const diagonal = node.querySelector(".liquidity-diagonal");
    const parent = level.parentId ? this.levelById.get(level.parentId) : null;
    if (!this.debug.showLiquidityConnections || !parent || level.swept) {
      diagonal.hidden = true;
      return;
    }

    const parentX = this.getCoordinate(parent.createdAt);
    const parentY = this.priceSeries.priceToCoordinate(parent.price);
    const childX = this.getCoordinate(level.createdAt);
    const childY = this.priceSeries.priceToCoordinate(level.price);
    if (parentX === null || parentY === null || childX === null || childY === null) {
      diagonal.hidden = true;
      return;
    }

    const width = visibleRight - visibleLeft;
    diagonal.hidden = false;
    diagonal.setAttribute("viewBox", `0 0 ${width} ${this.overlayRoot.clientHeight}`);
    diagonal.innerHTML = `<line x1="${parentX - visibleLeft}" y1="${parentY}" x2="${childX - visibleLeft}" y2="${childY}" />`;
  }

  positionLiquidityNode(node, level, visibleLeft) {
    const dot = node.querySelector(".liquidity-node");
    if (!dot) return;
    if (!this.debug.showLiquidityNodes || level.isPrimary || level.swept) {
      dot.hidden = true;
      return;
    }

    const x = this.getCoordinate(level.createdAt);
    const y = this.priceSeries.priceToCoordinate(level.price);
    if (x === null || y === null) {
      dot.hidden = true;
      return;
    }

    dot.hidden = false;
    dot.style.left = `${x - visibleLeft}px`;
    dot.style.top = `${y}px`;
  }

  className(level) {
    const role = level.isPrimary ? "primary" : level.isInternal ? "internal" : "secondary";
    return `liquidity-level ${level.type} ${role} ${level.swept ? "swept" : "active"}`;
  }

  getCoordinate(time) {
    const coordinate = this.chart.timeScale().timeToCoordinate(time);
    if (coordinate !== null) return coordinate;

    const index = this.timeIndex.get(time);
    const visibleRange = this.chart.timeScale().getVisibleLogicalRange();
    if (index === undefined || !visibleRange) return null;
    return (index - visibleRange.from) * this.barSpacing();
  }

  objectWidth(level) {
    const bars = Number(level.bars ?? 48);
    return Math.max(120, Math.min(this.maxObjectWidth(), bars * this.barSpacing()));
  }

  maxObjectWidth() {
    return 620;
  }

  barSpacing() {
    const options = this.chart.timeScale().options?.();
    return Number(options?.barSpacing ?? 8);
  }

  getPaneRight() {
    return Math.max(0, this.overlayRoot.clientWidth - 124);
  }
}
