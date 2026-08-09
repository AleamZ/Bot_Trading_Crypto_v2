const $ = (id) => document.getElementById(id);
const chartState = {
  instance: null,
  timer: null,
  module: null,
};
const defaultSettings = {
  watchlist: "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT",
  positionSizingMode: "fixed-margin",
  marginPerTrade: "200",
  leverage: "5",
  maxLeverage: "125",
  entryMode: "market",
  minNotional: "5",
  maxPositionSize: "100000",
  maxOpenPositions: "1",
  maxPositionPerSymbol: "1",
  minimumRiskReward: "2",
  maxTradesPerDay: "5",
  maxDailyLossPercent: "3",
  maxConsecutiveLosses: "3",
  cooldownAfterTradeMinutes: "30",
  maxDrawdownPercent: "10",
  tradingEnabled: "false",
  killSwitch: "false",
  emaPeriod: "50",
  swingLeft: "2",
  swingRight: "2",
  fvgMitigation: "ce",
  ltfFvgEntryMode: "ce",
  stopLossBufferMode: "ticks",
  stopLossBufferTicks: "5",
  stopLossBufferPercent: "0.1",
  stopLossAtrPeriod: "14",
  stopLossAtrMultiplier: "1",
  priceTickSize: "0.1",
  requireDisplacement: "false",
  displacementBodyMultiplier: "1.5",
  displacementLookback: "20",
  takeProfitMode: "external-liquidity",
  fixedRr: "2",
};
const settingsState = { ...defaultSettings };
let marketSymbols = [];
let symbolSearchTerm = "";

$("home-nav").addEventListener("click", () => showView("home"));
$("chart-nav").addEventListener("click", () => showView("chart"));
$("analysis-nav").addEventListener("click", () => showView("analysis"));
$("settings-nav").addEventListener("click", () => showView("settings"));
window.addEventListener("resize", () => resizeChart());

async function load() {
  const [snapshotResponse, watchlistResponse] = await Promise.all([
    fetch("/api/snapshot"),
    fetch("/api/watchlist/status"),
  ]);
  const snapshot = await snapshotResponse.json();
  const watchlist = await watchlistResponse.json();
  const engine = snapshot.engine ?? {};
  const runtime = snapshot.runtime ?? {};
  const store = snapshot.store ?? {};
  const db = store.databaseStatus ?? {};
  const account = runtime.account ?? {};
  const marketData = runtime.marketData ?? {};

  $("connection").textContent =
    `${runtime.symbol ?? "-"} · H1 ${engine.candleCounts?.H1 ?? 0} / M5 ${engine.candleCounts?.M5 ?? 0}`;
  setHeroBadge(
    "account-pill",
    account.connected ? "CONNECTED" : "DISCONNECTED",
    account.connected,
  );
  setHeroBadge(
    "network-pill",
    String(account.environment ?? "-").toUpperCase(),
    account.connected,
  );
  $("mode-detail").textContent = getModeDetail(runtime.executionMode);
  setPill(
    "db-pill",
    `DB: ${db.database ?? "unknown"}`,
    db.database === "postgres",
  );

  $("account").textContent = account.connected ? "Connected" : "Not connected";
  $("account-detail").textContent =
    `${account.environment ?? "-"} · ${account.label ?? "-"}`;
  $("wallet-balance").textContent = formatUsdt(account.walletBalance);
  $("available-balance").textContent = formatUsdt(account.availableBalance);

  $("database").textContent =
    db.database === "postgres" ? "Postgres" : "Memory";
  $("database-detail").textContent = db.reason ?? "-";

  $("market-data").textContent = marketData.connected ? "Connected" : "Offline";
  $("market-data-detail").textContent = marketData.label ?? "-";

  $("engine-state").textContent = engine.setupState ?? "-";
  $("engine-detail").textContent =
    `Margin ${formatUsdt(runtime.risk?.marginPerTrade)} · Leverage ${runtime.risk?.leverage ?? "-"}x`;

  $("trend").textContent = engine.trend ?? "-";
  $("symbol").textContent = runtime.symbol ?? "-";
  const htfFvg = store.currentHtfFvg ?? store.currentFvg;
  $("fvg").textContent = htfFvg
    ? `${htfFvg.direction} ${htfFvg.status}`
    : "-";
  $("fvg-detail").textContent = htfFvg
    ? `${formatPrice(htfFvg.lower)} - ${formatPrice(htfFvg.upper)} · CE ${formatPrice(htfFvg.midpoint)}`
    : "No active HTF FVG";
  $("signal").textContent = store.currentSignal
    ? `${store.currentSignal.type} ${store.currentSignal.direction}`
    : "-";
  $("signal-detail").textContent = store.currentSignal
    ? `Close ${formatPrice(store.currentSignal.close)}`
    : "Waiting for M5 BOS/CHOCH";
  $("risk").textContent = store.riskStatus
    ? `${store.riskStatus.accepted ? "Passed" : "Rejected"}`
    : "-";
  $("risk-detail").textContent = store.riskStatus
    ? [
        `Margin ${formatUsdt(store.riskStatus.margin)}`,
        `Size ${formatUsdt(store.riskStatus.positionSize)}`,
        `Qty ${formatQuantity(store.riskStatus.quantity)}`,
        `Loss ${formatUsdt(store.riskStatus.estimatedLoss)}`,
        `Profit ${formatUsdt(store.riskStatus.estimatedProfit)}`,
        `RR ${formatRatio(store.riskStatus.riskReward)}`
      ].join(" · ")
    : "Risk manager has not run";

  $("event-count").textContent = `${store.events?.length ?? 0} events`;
  const events = $("events");
  events.replaceChildren(
    ...(store.events ?? []).toReversed().map((event) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("code");
      title.textContent = event.type;
      detail.textContent = event.reason ?? JSON.stringify(event);
      item.append(title, detail);
      return item;
    }),
  );

  renderWatchlist(watchlist.rows ?? []);
}

function setPill(id, text, ok) {
  const element = $(id);
  element.textContent = text;
  element.dataset.status = ok ? "ok" : "warn";
}

function setHeroBadge(id, text, ok) {
  const element = $(id);
  element.textContent = text;
  element.dataset.status = ok ? "ok" : "warn";
}

function formatUsdt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value)))
    return "-";
  return `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatQuantity(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatRatio(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value)))
    return "-";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function getModeDetail(mode) {
  if (mode === "paper")
    return "Paper trading: signals are simulated, no Binance orders are sent.";
  if (mode === "testnet")
    return "Testnet trading: orders are sent to Binance Futures Testnet.";
  if (mode === "live")
    return "Live trading: real orders are sent to Binance Futures.";
  return "-";
}

function renderWatchlist(rows) {
  $("watchlist-count").textContent = `${rows.length} symbols`;
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "empty-position";
    cell.colSpan = 7;
    cell.textContent = "Waiting for scanner";
    row.append(cell);
    $("watchlist-body").replaceChildren(row);
    return;
  }

  $("watchlist-body").replaceChildren(
    ...rows.map((item) => {
      const row = document.createElement("tr");
      row.append(
        tableCell(item.symbol),
        tableCell(item.state),
        tableCell(item.conditions),
        tableCell(item.rr === null || item.rr === undefined ? "-" : formatRatio(item.rr)),
        tableCell(item.position),
        tableCell(item.status),
        tableCell(item.lastScanAt ? new Date(item.lastScanAt).toLocaleTimeString() : "-"),
      );
      return row;
    }),
  );
}

function tableCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value ?? "-";
  return cell;
}

$("refresh").addEventListener("click", load);
$("chart-refresh").addEventListener("click", loadChart);
$("chart-symbol").addEventListener("change", loadChart);
$("chart-interval").addEventListener("change", loadChart);
$("analysis-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadAnalysis();
});
$("settings-save").addEventListener("click", saveSettings);
$("settings-reset").addEventListener("click", resetSettings);
$("setting-margin-per-order").addEventListener("input", updateSettingFromInput);
$("setting-symbol-search").addEventListener("input", (event) => {
  symbolSearchTerm = event.target.value.trim().toUpperCase();
  renderWatchlistSettings();
});
$("available-symbols").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-watchlist-symbol]");
  if (!checkbox) return;
  toggleWatchlistSymbol(checkbox.dataset.watchlistSymbol, checkbox.checked);
});
$("selected-watchlist").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-symbol]");
  if (!button) return;
  toggleWatchlistSymbol(button.dataset.removeSymbol, false);
});
$("setting-leverage").addEventListener("input", updateSettingFromInput);
$("setting-max-leverage").addEventListener("input", updateSettingFromInput);
$("setting-min-notional").addEventListener("input", updateSettingFromInput);
$("setting-max-position-size").addEventListener("input", updateSettingFromInput);
$("setting-max-open-positions").addEventListener("input", updateSettingFromInput);
$("setting-max-position-per-symbol").addEventListener("input", updateSettingFromInput);
$("setting-minimum-rr").addEventListener("input", updateSettingFromInput);
$("setting-max-trades-per-day").addEventListener("input", updateSettingFromInput);
$("setting-daily-loss-limit").addEventListener("input", updateSettingFromInput);
$("setting-max-consecutive-losses").addEventListener("input", updateSettingFromInput);
$("setting-cooldown").addEventListener("input", updateSettingFromInput);
$("setting-max-drawdown").addEventListener("input", updateSettingFromInput);
$("setting-ema-period").addEventListener("input", updateSettingFromInput);
$("setting-swing-left").addEventListener("input", updateSettingFromInput);
$("setting-swing-right").addEventListener("input", updateSettingFromInput);
$("setting-sl-buffer-ticks").addEventListener("input", updateSettingFromInput);
$("setting-sl-buffer-percent").addEventListener("input", updateSettingFromInput);
$("setting-sl-atr-period").addEventListener("input", updateSettingFromInput);
$("setting-sl-atr-multiplier").addEventListener("input", updateSettingFromInput);
$("setting-price-tick-size").addEventListener("input", updateSettingFromInput);
$("setting-displacement-body").addEventListener("input", updateSettingFromInput);
$("setting-displacement-lookback").addEventListener("input", updateSettingFromInput);
$("setting-fixed-rr").addEventListener("input", updateSettingFromInput);
document.querySelectorAll("[data-setting-group]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[data-setting-value]");
    if (!button) return;
    settingsState[group.dataset.settingGroup] = button.dataset.settingValue;
    renderSettings();
    saveSettings();
  });
});
loadSettings();
setInterval(load, 1000);
load();

function showView(view) {
  $("home-view").classList.toggle("active", view === "home");
  $("chart-view").classList.toggle("active", view === "chart");
  $("analysis-view").classList.toggle("active", view === "analysis");
  $("settings-view").classList.toggle("active", view === "settings");
  $("home-nav").classList.toggle("active", view === "home");
  $("chart-nav").classList.toggle("active", view === "chart");
  $("analysis-nav").classList.toggle("active", view === "analysis");
  $("settings-nav").classList.toggle("active", view === "settings");

  if (view === "chart") {
    loadChart();
    chartState.timer ??= setInterval(loadChart, 5000);
    requestAnimationFrame(resizeChart);
  } else if (chartState.timer) {
    clearInterval(chartState.timer);
    chartState.timer = null;
  }

  if (view === "analysis") {
    const chartSymbol = $("chart-symbol").value.trim().toUpperCase();
    if (chartSymbol) $("analysis-symbol").value = chartSymbol;
    loadAnalysis();
  }
}

async function ensureChart() {
  if (chartState.instance) return;
  chartState.module ??= import("./chart/Chart.js");
  const { TradingChart } = await chartState.module;

  chartState.instance = new TradingChart({
    container: $("price-chart"),
    overlayRoot: $("chart-overlay"),
    statusElement: $("chart-status"),
    accountTableHead: $("account-table-head"),
    positionsBody: $("positions-body"),
    positionsCount: $("positions-count"),
    openOrdersCount: $("open-orders-count"),
    orderHistoryCount: $("order-history-count"),
    tradeHistoryCount: $("trade-history-count"),
    tabButtons: [...document.querySelectorAll("[data-account-tab]")],
  });
}

async function loadChart() {
  try {
    await ensureChart();
    const symbol = $("chart-symbol").value.trim().toUpperCase() || "BTCUSDT";
    const interval = $("chart-interval").value;
    $("chart-symbol").value = symbol;
    await chartState.instance.load({ symbol, interval, limit: 300 });
  } catch (error) {
    $("chart-status").textContent = error instanceof Error ? error.message : String(error);
  }
}

function resizeChart() {
  chartState.instance?.resize();
}

async function loadAnalysis() {
  const symbol = $("analysis-symbol").value.trim().toUpperCase() || "BTCUSDT";
  $("analysis-symbol").value = symbol;
  $("analysis-status").textContent = `Analyzing ${symbol}`;
  $("analysis-run").disabled = true;

  try {
    const response = await fetch(`/api/analysis?symbol=${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error(`Analysis request failed: ${response.status}`);
    renderAnalysis(await response.json());
  } catch (error) {
    $("analysis-status").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    $("analysis-run").disabled = false;
  }
}

function renderAnalysis(analysis) {
  const conditions = analysis.conditions ?? [];
  $("analysis-status").textContent = `${analysis.symbol ?? "-"} · ${conditions.length} conditions checked`;
  $("analysis-symbol-label").textContent = analysis.symbol ?? "-";
  $("analysis-checked-at").textContent = analysis.checkedAt ? new Date(analysis.checkedAt).toLocaleString() : "-";
  $("analysis-trend").textContent = analysis.trend?.direction ?? "-";
  $("analysis-trend-detail").textContent =
    analysis.trend?.ema !== null && analysis.trend?.ema !== undefined
      ? `Close ${formatPrice(analysis.trend.close)} · EMA ${formatPrice(analysis.trend.ema)}`
      : analysis.trend?.reason ?? "-";
  $("analysis-summary-text").textContent = analysis.setupStatus ?? analysis.summary ?? "-";
  $("analysis-plan").textContent = analysis.plan
    ? `Entry ${formatPrice(analysis.plan.entry)} · SL ${formatPrice(analysis.plan.stopLoss)} · TP ${formatPrice(analysis.plan.takeProfit)} · RR ${formatRatio(analysis.plan.riskReward)}`
    : analysis.summary ?? "No entry plan";
  $("analysis-condition-count").textContent = analysis.setupStatus ?? "SETUP STATUS";

  $("analysis-conditions").replaceChildren(
    ...conditions.map((condition, index) => analysisConditionItem(condition, index + 1)),
  );

  const risk = analysis.riskManagement ?? {};
  const riskChecks = risk.checks ?? [];
  $("analysis-risk-final").textContent = risk.final ?? "WAITING";
  $("analysis-risk-checks").replaceChildren(
    ...riskChecks.map((check) => analysisConditionItem(check, null)),
  );
}

function analysisConditionItem(condition, number) {
  const item = document.createElement("li");
  const mark = document.createElement("span");
  const body = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  item.className = `condition-item ${analysisStatusClass(condition.status)}`;
  mark.className = "condition-mark";
  mark.textContent = condition.status === "PASSED" ? "✓" : condition.status === "INVALIDATED" ? "×" : "⏳";
  title.textContent = number === null ? condition.label : `${number}. ${condition.label}`;
  detail.textContent = `${condition.status ?? "WAITING"} · ${condition.detail ?? "-"}`;
  body.append(title, detail);
  item.append(mark, body);
  return item;
}

function analysisStatusClass(status) {
  if (status === "PASSED") return "pass";
  if (status === "INVALIDATED") return "invalidated";
  return "waiting";
}

async function loadSettings() {
  try {
    const [response, symbolsResponse] = await Promise.all([
      fetch("/api/settings"),
      fetch("/api/market/symbols"),
    ]);
    if (!response.ok) throw new Error(`Settings request failed: ${response.status}`);
    if (!symbolsResponse.ok) throw new Error(`Symbols request failed: ${symbolsResponse.status}`);
    marketSymbols = await symbolsResponse.json();
    Object.assign(settingsState, defaultSettings, settingsFromApi(await response.json()));
  } catch {
    Object.assign(settingsState, defaultSettings);
    marketSymbols = [];
  }
  renderSettings();
}

function renderSettings() {
  renderWatchlistSettings();
  $("setting-margin-per-order").value = settingsState.marginPerTrade;
  $("setting-leverage").value = settingsState.leverage;
  $("setting-max-leverage").value = settingsState.maxLeverage;
  $("setting-min-notional").value = settingsState.minNotional;
  $("setting-max-position-size").value = settingsState.maxPositionSize;
  $("setting-max-open-positions").value = settingsState.maxOpenPositions;
  $("setting-max-position-per-symbol").value = settingsState.maxPositionPerSymbol;
  $("setting-minimum-rr").value = settingsState.minimumRiskReward;
  $("setting-max-trades-per-day").value = settingsState.maxTradesPerDay;
  $("setting-daily-loss-limit").value = settingsState.maxDailyLossPercent;
  $("setting-max-consecutive-losses").value = settingsState.maxConsecutiveLosses;
  $("setting-cooldown").value = settingsState.cooldownAfterTradeMinutes;
  $("setting-max-drawdown").value = settingsState.maxDrawdownPercent;
  $("setting-ema-period").value = settingsState.emaPeriod;
  $("setting-swing-left").value = settingsState.swingLeft;
  $("setting-swing-right").value = settingsState.swingRight;
  $("setting-sl-buffer-ticks").value = settingsState.stopLossBufferTicks;
  $("setting-sl-buffer-percent").value = settingsState.stopLossBufferPercent;
  $("setting-sl-atr-period").value = settingsState.stopLossAtrPeriod;
  $("setting-sl-atr-multiplier").value = settingsState.stopLossAtrMultiplier;
  $("setting-price-tick-size").value = settingsState.priceTickSize;
  $("setting-displacement-body").value = settingsState.displacementBodyMultiplier;
  $("setting-displacement-lookback").value = settingsState.displacementLookback;
  $("setting-fixed-rr").value = settingsState.fixedRr;

  document.querySelectorAll("[data-setting-group]").forEach((group) => {
    const value = settingsState[group.dataset.settingGroup];
    group.querySelectorAll("[data-setting-value]").forEach((button) => {
      button.classList.toggle("active", button.dataset.settingValue === value);
    });
  });
}

function updateSettingFromInput(event) {
  const fieldById = {
    "setting-watchlist": "watchlist",
    "setting-margin-per-order": "marginPerTrade",
    "setting-leverage": "leverage",
    "setting-max-leverage": "maxLeverage",
    "setting-min-notional": "minNotional",
    "setting-max-position-size": "maxPositionSize",
    "setting-max-open-positions": "maxOpenPositions",
    "setting-max-position-per-symbol": "maxPositionPerSymbol",
    "setting-minimum-rr": "minimumRiskReward",
    "setting-max-trades-per-day": "maxTradesPerDay",
    "setting-daily-loss-limit": "maxDailyLossPercent",
    "setting-max-consecutive-losses": "maxConsecutiveLosses",
    "setting-cooldown": "cooldownAfterTradeMinutes",
    "setting-max-drawdown": "maxDrawdownPercent",
    "setting-ema-period": "emaPeriod",
    "setting-swing-left": "swingLeft",
    "setting-swing-right": "swingRight",
    "setting-sl-buffer-ticks": "stopLossBufferTicks",
    "setting-sl-buffer-percent": "stopLossBufferPercent",
    "setting-sl-atr-period": "stopLossAtrPeriod",
    "setting-sl-atr-multiplier": "stopLossAtrMultiplier",
    "setting-price-tick-size": "priceTickSize",
    "setting-displacement-body": "displacementBodyMultiplier",
    "setting-displacement-lookback": "displacementLookback",
    "setting-fixed-rr": "fixedRr",
  };
  const field = fieldById[event.target.id];
  if (!field) return;
  settingsState[field] = event.target.value;
  saveSettings();
}

async function saveSettings() {
  $("settings-status").textContent = "Saving";
  const payload = settingsPayload();
  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    $("settings-status").textContent = `Save failed: ${response.status}`;
    return;
  }
  Object.assign(settingsState, settingsFromApi(await response.json()));
  renderSettings();
  $("settings-status").textContent = "Saved";
}

function resetSettings() {
  Object.assign(settingsState, defaultSettings);
  renderSettings();
  saveSettings();
}

function settingsFromApi(settings) {
  return {
    ...settings,
    watchlist: Array.isArray(settings.watchlist) ? settings.watchlist.join(",") : String(settings.watchlist ?? defaultSettings.watchlist),
    positionSizingMode: String(settings.positionSizingMode ?? defaultSettings.positionSizingMode),
    marginPerTrade: String(settings.marginPerTrade ?? defaultSettings.marginPerTrade),
    leverage: String(settings.leverage ?? defaultSettings.leverage),
    maxLeverage: String(settings.maxLeverage ?? defaultSettings.maxLeverage),
    entryMode: String(settings.entryMode ?? defaultSettings.entryMode),
    minNotional: String(settings.minNotional ?? defaultSettings.minNotional),
    maxPositionSize: String(settings.maxPositionSize ?? defaultSettings.maxPositionSize),
    maxOpenPositions: String(settings.maxOpenPositions ?? defaultSettings.maxOpenPositions),
    maxPositionPerSymbol: String(settings.maxPositionPerSymbol ?? defaultSettings.maxPositionPerSymbol),
    minimumRiskReward: String(settings.minimumRiskReward ?? defaultSettings.minimumRiskReward),
    maxTradesPerDay: String(settings.maxTradesPerDay ?? defaultSettings.maxTradesPerDay),
    maxDailyLossPercent: String(settings.maxDailyLossPercent ?? defaultSettings.maxDailyLossPercent),
    maxConsecutiveLosses: String(settings.maxConsecutiveLosses ?? defaultSettings.maxConsecutiveLosses),
    cooldownAfterTradeMinutes: String(settings.cooldownAfterTradeMinutes ?? defaultSettings.cooldownAfterTradeMinutes),
    maxDrawdownPercent: String(settings.maxDrawdownPercent ?? defaultSettings.maxDrawdownPercent),
    tradingEnabled: String(settings.tradingEnabled ?? "false"),
    killSwitch: String(settings.killSwitch ?? "false"),
    emaPeriod: String(settings.emaPeriod ?? defaultSettings.emaPeriod),
    swingLeft: String(settings.swingLeft ?? defaultSettings.swingLeft),
    swingRight: String(settings.swingRight ?? defaultSettings.swingRight),
    fvgMitigation: String(settings.fvgMitigation ?? defaultSettings.fvgMitigation),
    ltfFvgEntryMode: String(settings.ltfFvgEntryMode ?? defaultSettings.ltfFvgEntryMode),
    stopLossBufferMode: String(settings.stopLossBufferMode ?? defaultSettings.stopLossBufferMode),
    stopLossBufferTicks: String(settings.stopLossBufferTicks ?? defaultSettings.stopLossBufferTicks),
    stopLossBufferPercent: String(settings.stopLossBufferPercent ?? defaultSettings.stopLossBufferPercent),
    stopLossAtrPeriod: String(settings.stopLossAtrPeriod ?? defaultSettings.stopLossAtrPeriod),
    stopLossAtrMultiplier: String(settings.stopLossAtrMultiplier ?? defaultSettings.stopLossAtrMultiplier),
    priceTickSize: String(settings.priceTickSize ?? defaultSettings.priceTickSize),
    requireDisplacement: String(settings.requireDisplacement ?? "false"),
    displacementBodyMultiplier: String(settings.displacementBodyMultiplier ?? defaultSettings.displacementBodyMultiplier),
    displacementLookback: String(settings.displacementLookback ?? defaultSettings.displacementLookback),
    takeProfitMode: String(settings.takeProfitMode ?? defaultSettings.takeProfitMode),
    fixedRr: String(settings.fixedRr ?? defaultSettings.fixedRr),
  };
}

function settingsPayload() {
  const watchlist = getSelectedWatchlist();
  return {
    watchlist,
    symbol: watchlist[0] ?? "BTCUSDT",
    positionSizingMode: settingsState.positionSizingMode,
    marginPerTrade: Number(settingsState.marginPerTrade),
    leverage: Number(settingsState.leverage),
    maxLeverage: Number(settingsState.maxLeverage),
    entryMode: settingsState.entryMode,
    minNotional: Number(settingsState.minNotional),
    maxPositionSize: Number(settingsState.maxPositionSize),
    maxOpenPositions: Number(settingsState.maxOpenPositions),
    maxPositionPerSymbol: Number(settingsState.maxPositionPerSymbol),
    minimumRiskReward: Number(settingsState.minimumRiskReward),
    maxTradesPerDay: Number(settingsState.maxTradesPerDay),
    maxDailyLossPercent: Number(settingsState.maxDailyLossPercent),
    maxConsecutiveLosses: Number(settingsState.maxConsecutiveLosses),
    cooldownAfterTradeMinutes: Number(settingsState.cooldownAfterTradeMinutes),
    maxDrawdownPercent: Number(settingsState.maxDrawdownPercent),
    tradingEnabled: settingsState.tradingEnabled === "true",
    killSwitch: settingsState.killSwitch === "true",
    emaPeriod: Number(settingsState.emaPeriod),
    swingLeft: Number(settingsState.swingLeft),
    swingRight: Number(settingsState.swingRight),
    fvgMitigation: settingsState.fvgMitigation,
    ltfFvgEntryMode: settingsState.ltfFvgEntryMode,
    stopLossBufferMode: settingsState.stopLossBufferMode,
    stopLossBufferTicks: Number(settingsState.stopLossBufferTicks),
    stopLossBufferPercent: Number(settingsState.stopLossBufferPercent),
    stopLossAtrPeriod: Number(settingsState.stopLossAtrPeriod),
    stopLossAtrMultiplier: Number(settingsState.stopLossAtrMultiplier),
    priceTickSize: Number(settingsState.priceTickSize),
    requireDisplacement: settingsState.requireDisplacement === "true",
    displacementBodyMultiplier: Number(settingsState.displacementBodyMultiplier),
    displacementLookback: Number(settingsState.displacementLookback),
    takeProfitMode: settingsState.takeProfitMode,
    fixedRr: Number(settingsState.fixedRr),
  };
}

function renderWatchlistSettings() {
  const selected = getSelectedWatchlist();
  $("selected-watchlist-count").textContent = `${selected.length} selected`;
  $("available-watchlist-count").textContent = marketSymbols.length > 0 ? `${marketSymbols.length} symbols` : "Unavailable";

  if (selected.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-selection";
    empty.textContent = "No symbols selected";
    $("selected-watchlist").replaceChildren(empty);
  } else {
    $("selected-watchlist").replaceChildren(
      ...selected.map((symbol) => {
        const chip = document.createElement("button");
        chip.className = "symbol-chip";
        chip.type = "button";
        chip.dataset.removeSymbol = symbol;
        chip.textContent = `${symbol} ×`;
        return chip;
      }),
    );
  }

  const filtered = filterAvailableSymbols();
  if (filtered.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-selection";
    empty.textContent = marketSymbols.length === 0 ? "Could not load Binance Futures symbols" : "No matching symbols";
    $("available-symbols").replaceChildren(empty);
    return;
  }

  const selectedSet = new Set(selected);
  $("available-symbols").replaceChildren(
    ...filtered.map((item) => {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      const text = document.createElement("span");
      label.className = "symbol-check";
      checkbox.type = "checkbox";
      checkbox.checked = selectedSet.has(item.symbol);
      checkbox.dataset.watchlistSymbol = item.symbol;
      text.textContent = `${item.symbol} · ${item.baseAsset}/${item.quoteAsset}`;
      label.append(checkbox, text);
      return label;
    }),
  );
}

function filterAvailableSymbols() {
  const term = symbolSearchTerm;
  const source = marketSymbols.length > 0 ? marketSymbols : getSelectedWatchlist().map((symbol) => ({ symbol, baseAsset: symbol.replace(/USDT$/, ""), quoteAsset: "USDT" }));
  return source
    .filter((item) => !term || item.symbol.includes(term) || item.baseAsset?.includes(term))
    .slice(0, 120);
}

function getSelectedWatchlist() {
  return [...new Set(String(settingsState.watchlist ?? "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean))];
}

function setSelectedWatchlist(symbols) {
  settingsState.watchlist = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].join(",");
}

function toggleWatchlistSymbol(symbol, enabled) {
  if (!symbol) return;
  const normalized = symbol.trim().toUpperCase();
  const validSymbols = new Set(marketSymbols.map((item) => item.symbol));
  if (marketSymbols.length > 0 && !validSymbols.has(normalized)) return;
  const selected = getSelectedWatchlist();
  const next = enabled ? [...selected, normalized] : selected.filter((item) => item !== normalized);
  setSelectedWatchlist(next);
  renderWatchlistSettings();
}
