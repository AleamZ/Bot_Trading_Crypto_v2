export class PositionRenderer {
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
    this.latestCandle = candles.at(-1) ?? null;
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
      const node = this.nodes.get(item.id) ?? this.createNode(item);
      this.nodes.set(item.id, node);
      this.updateNode(node, item);
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

  createNode(item) {
    const node = document.createElement("div");
    node.className = `position-overlay ${item.side} ${positionState(item)}`;
    node.innerHTML = `
      <div class="position-reward"></div>
      <div class="position-risk"></div>
      <svg class="position-diagonal" aria-hidden="true"></svg>
      <div class="position-line position-tp"><span>TP</span></div>
      <div class="position-line position-entry"><span>ENTRY</span></div>
      <div class="position-line position-sl"><span>SL</span></div>
      <div class="position-label"></div>
    `;
    this.overlayRoot.append(node);
    return node;
  }

  updateNode(node, item) {
    const state = positionState(item);
    node.className = `position-overlay ${item.side} ${state} ${item.source}`;
    const label = node.querySelector(".position-label");
    const status = state === "pending" ? "Pending" : item.source === "manual" ? "Manual" : "Active";
    const rr = item.riskReward !== null && item.riskReward !== undefined && Number.isFinite(Number(item.riskReward)) ? ` · RR ${Number(item.riskReward).toFixed(2)}` : "";
    const margin = item.margin ? ` · M ${formatCompact(item.margin)}` : "";
    const leverage = item.leverage ? ` · ${item.leverage}x` : "";
    const qty = item.quantity ? ` · Q ${formatQuantity(item.quantity)}` : "";
    label.textContent = `${status} ${item.side.toUpperCase()}${rr}${margin}${leverage}${qty}`;
  }

  positionNode(node, item) {
    const entryY = this.priceSeries.priceToCoordinate(item.entry);
    const slY = isPositiveNumber(item.stopLoss) ? this.priceSeries.priceToCoordinate(item.stopLoss) : null;
    const tpY = isPositiveNumber(item.takeProfit) ? this.priceSeries.priceToCoordinate(item.takeProfit) : null;
    const currentY = this.latestCandle ? this.priceSeries.priceToCoordinate(this.latestCandle.close) : null;
    const currentX = this.latestCandle ? this.getCoordinate(this.latestCandle.time) : null;
    const left = this.getCoordinate(item.createdAt);
    if (entryY === null || left === null) {
      node.hidden = true;
      return;
    }

    const width = this.objectWidth(item);
    const paneRight = this.getPaneRight();
    if (left > paneRight || left + width < 0) {
      node.hidden = true;
      return;
    }

    const visibleLeft = Math.max(0, left);
    const visibleRight = Math.min(paneRight, left + width);
    const visibleWidth = Math.max(36, visibleRight - visibleLeft);
    node.hidden = false;
    node.style.left = `${visibleLeft}px`;
    node.style.top = "0px";
    node.style.width = `${visibleWidth}px`;
    node.style.height = `${this.overlayRoot.clientHeight}px`;
    this.currentVisibleWidth = visibleWidth;

    this.placeLine(node.querySelector(".position-entry"), entryY, "ENTRY", item.entry);
    this.placeOptionalLine(node.querySelector(".position-sl"), slY, "SL", item.stopLoss);
    this.placeOptionalLine(node.querySelector(".position-tp"), tpY, "TP", item.takeProfit);
    this.placeLabel(node.querySelector(".position-label"), entryY, item.side);
    this.placeBoxes(node, item, entryY, slY, tpY, currentY, currentX, visibleLeft);
  }

  placeLine(node, y, label, price) {
    node.hidden = false;
    node.style.top = `${y}px`;
    node.querySelector("span").textContent = `${label} ${formatPrice(price)}`;
  }

  placeOptionalLine(node, y, label, price) {
    if (y === null || price === null || price === undefined) {
      node.hidden = true;
      return;
    }
    this.placeLine(node, y, label, price);
  }

  placeLabel(node, entryY, side) {
    node.style.top = `${side === "long" ? entryY - 28 : entryY + 12}px`;
  }

  placeBoxes(node, item, entryY, slY, tpY, currentY, currentX, visibleLeft) {
    const risk = node.querySelector(".position-risk");
    const reward = node.querySelector(".position-reward");
    const diagonal = node.querySelector(".position-diagonal");

    if (slY === null || tpY === null || !hasValidBracket(item)) {
      risk.hidden = true;
      reward.hidden = true;
      diagonal.hidden = true;
      return;
    }

    if (item.side === "long") {
      this.placeBox(reward, entryY, tpY);
      this.placeBox(risk, slY, entryY);
      this.placeDiagonal(diagonal, entryY, currentY, currentX, visibleLeft);
      return;
    }

    this.placeBox(reward, tpY, entryY);
    this.placeBox(risk, entryY, slY);
    this.placeDiagonal(diagonal, entryY, currentY, currentX, visibleLeft);
  }

  placeBox(node, firstY, secondY) {
    node.hidden = false;
    node.style.top = `${Math.min(firstY, secondY)}px`;
    node.style.height = `${Math.max(2, Math.abs(secondY - firstY))}px`;
  }

  placeDiagonal(node, entryY, currentY, currentX, visibleLeft) {
    if (currentY === null || currentX === null) {
      node.hidden = true;
      return;
    }

    node.hidden = false;
    const left = 0;
    const right = Math.max(36, this.currentVisibleWidth ?? 36);
    const endX = Math.max(0, Math.min(right, currentX - visibleLeft));
    node.setAttribute("viewBox", `0 0 ${right} ${this.overlayRoot.clientHeight}`);
    node.style.width = `${right}px`;
    node.style.height = `${this.overlayRoot.clientHeight}px`;
    node.innerHTML = `<line x1="${left}" y1="${entryY}" x2="${endX}" y2="${currentY}" />`;
  }

  getCoordinate(time) {
    const coordinate = this.chart.timeScale().timeToCoordinate(time);
    if (coordinate !== null) return coordinate;

    const index = this.timeIndex.get(time);
    const visibleRange = this.chart.timeScale().getVisibleLogicalRange();
    if (index === undefined || !visibleRange) return null;
    return (index - visibleRange.from) * this.barSpacing();
  }

  objectWidth(item) {
    const bars = Number(item.bars ?? 36);
    return Math.max(120, Math.min(520, bars * this.barSpacing()));
  }

  barSpacing() {
    const options = this.chart.timeScale().options?.();
    return Number(options?.barSpacing ?? 8);
  }

  getPaneRight() {
    return Math.max(0, this.overlayRoot.clientWidth - 124);
  }
}

function positionState(item) {
  return item.state ?? item.status ?? "active";
}

function isPositiveNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function hasValidBracket(item) {
  if (!isPositiveNumber(item.entry) || !isPositiveNumber(item.stopLoss) || !isPositiveNumber(item.takeProfit)) return false;
  const entry = Number(item.entry);
  const stopLoss = Number(item.stopLoss);
  const takeProfit = Number(item.takeProfit);
  if (item.side === "long") return takeProfit > entry && stopLoss < entry;
  return takeProfit < entry && stopLoss > entry;
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatQuantity(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 5 });
}

function formatCompact(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
