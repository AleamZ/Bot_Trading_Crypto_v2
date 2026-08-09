const $ = (id) => document.getElementById(id);
const chartState = {
  instance: null,
  timer: null,
  module: null,
};
const settingsKey = "smc-futures-settings";
const defaultSettings = {
  size: "",
  orderType: "limit",
  marginMode: "cross",
  leverage: "5",
  riskReward: "2",
};
const settingsState = { ...defaultSettings };

$("home-nav").addEventListener("click", () => showView("home"));
$("chart-nav").addEventListener("click", () => showView("chart"));
$("settings-nav").addEventListener("click", () => showView("settings"));
window.addEventListener("resize", () => resizeChart());

async function load() {
  const response = await fetch("/api/snapshot");
  const snapshot = await response.json();
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
  if (mode === "testnet")
    return "Testnet trading: orders are sent to Binance Futures Testnet.";
  if (mode === "live")
    return "Live trading: real orders are sent to Binance Futures.";
  return "-";
}

$("refresh").addEventListener("click", load);
$("chart-refresh").addEventListener("click", loadChart);
$("chart-symbol").addEventListener("change", loadChart);
$("chart-interval").addEventListener("change", loadChart);
$("settings-save").addEventListener("click", saveSettings);
$("settings-reset").addEventListener("click", resetSettings);
$("setting-size").addEventListener("input", updateSettingFromInput);
$("setting-leverage").addEventListener("input", updateSettingFromInput);
$("setting-risk-reward").addEventListener("input", updateSettingFromInput);
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
  $("settings-view").classList.toggle("active", view === "settings");
  $("home-nav").classList.toggle("active", view === "home");
  $("chart-nav").classList.toggle("active", view === "chart");
  $("settings-nav").classList.toggle("active", view === "settings");

  if (view === "chart") {
    loadChart();
    chartState.timer ??= setInterval(loadChart, 5000);
    requestAnimationFrame(resizeChart);
  } else if (chartState.timer) {
    clearInterval(chartState.timer);
    chartState.timer = null;
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
    positionsBody: $("positions-body"),
    positionsCount: $("positions-count"),
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

function loadSettings() {
  try {
    Object.assign(
      settingsState,
      defaultSettings,
      JSON.parse(localStorage.getItem(settingsKey) ?? "{}"),
    );
  } catch {
    Object.assign(settingsState, defaultSettings);
  }
  renderSettings();
}

function renderSettings() {
  $("setting-size").value = settingsState.size;
  $("setting-leverage").value = settingsState.leverage;
  $("setting-risk-reward").value = settingsState.riskReward;

  document.querySelectorAll("[data-setting-group]").forEach((group) => {
    const value = settingsState[group.dataset.settingGroup];
    group.querySelectorAll("[data-setting-value]").forEach((button) => {
      button.classList.toggle("active", button.dataset.settingValue === value);
    });
  });
}

function updateSettingFromInput(event) {
  const fieldById = {
    "setting-size": "size",
    "setting-leverage": "leverage",
    "setting-risk-reward": "riskReward",
  };
  const field = fieldById[event.target.id];
  if (!field) return;
  settingsState[field] = event.target.value;
  saveSettings();
}

function saveSettings() {
  localStorage.setItem(settingsKey, JSON.stringify(settingsState));
  $("settings-status").textContent = "Saved";
}

function resetSettings() {
  Object.assign(settingsState, defaultSettings);
  renderSettings();
  saveSettings();
}
