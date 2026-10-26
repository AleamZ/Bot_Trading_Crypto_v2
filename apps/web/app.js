import { apiFetch, apiUrl } from "./apiClient.js";

const $ = (id) => document.getElementById(id);
const HOME_POLL_INTERVAL_MS = 10_000;
const CHART_POLL_INTERVAL_MS = 10_000;
// While the live stream is up it carries the monitor data; the snapshot only refreshes balances and daily risk.
const LIVE_SNAPSHOT_INTERVAL_MS = 60_000;
// After the server refuses the stream (e.g. runtime unavailable), poll and try the stream again this much later.
const LIVE_RETRY_MS = 30_000;
const AI_STEPS_KEPT = 60;
const LAST_MAIN_VIEW_STORAGE_KEY = "smc-futures-bot:last-main-view";
const THEME_STORAGE_KEY = "smc-futures-bot:theme";
const MAIN_VIEWS = new Set(["home", "chart", "analysis", "settings"]);
const DEFAULT_SYMBOL = "BTCUSDT";
const CHART_LIBRARY_URL = "https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js";
const chartState = {
  instance: null,
  timer: null,
  module: null,
  library: null,
};
const authState = {
  user: null,
  dashboardTimer: null,
};
const accountState = {
  accounts: [],
  activeAccount: null,
  pendingMode: null,
  testedCredentials: null,
  lastConnection: null,
  lastBinanceAccount: null,
};
const activityState = {
  events: [],
  symbolFilter: "all",
  typeFilter: "all",
};
const homeState = {
  snapshot: null,
  snapshotAt: 0,
};
// Server-Sent Events from /api/trading-accounts/:id/stream; status off | connecting | live | polling.
const liveState = {
  source: null,
  accountId: null,
  status: "off",
  retryTimer: null,
  monitor: null,
  store: null,
  aiSteps: [],
};
const defaultSettings = {
  watchlist: "",
  settingsMode: "advanced",
  riskLevel: "3",
  positionSizingMode: "risk-based",
  riskPerTradeUsdt: "20",
  maxLeverage: "125",
  maxMarginUsagePercent: "20",
  maxTotalMarginUsagePercent: "60",
  liquidationSafetyBufferPercent: "0.5",
  marginMode: "ISOLATED",
  entryMode: "market",
  maxOpenPositions: "1",
  maxPositionPerSymbol: "1",
  minimumRiskReward: "2",
  dailyProfitLimitR: "10",
  dailyLossLimitR: "2",
  maxDrawdownPercent: "10",
  tradingEnabled: "false",
  killSwitch: "false",
  realExecutionMode: "LOCKED",
  emaPeriod: "50",
  swingLeft: "2",
  swingRight: "2",
  stopLossBufferMode: "ticks",
  stopLossBufferTicks: "5",
  stopLossBufferPercent: "0.1",
  stopLossAtrPeriod: "14",
  stopLossAtrMultiplier: "1",
  requireDisplacement: "false",
  displacementBodyMultiplier: "1.5",
  displacementLookback: "20",
  aiTradingMode: "OFF",
  aiModel: "",
  aiMinConfidence: "0.7",
};
const settingsState = { ...defaultSettings };
const realSafetyState = {
  mode: "LOCKED",
  masterLiveExecutionEnabled: false,
  proposals: [],
};
let marketSymbols = [];
// Account whose symbol list is in marketSymbols, so reopening Settings skips the large symbols request.
let marketSymbolsAccountId = null;
let tradingPresets = [];
let symbolSearchTerm = "";
let settingsRequestSequence = 0;
let analysisRequestSequence = 0;
let dashboardRequestSequence = 0;
let activeView = null;

$("home-nav").addEventListener("click", () => showView("home"));
$("chart-nav").addEventListener("click", () => showView("chart"));
$("analysis-nav").addEventListener("click", () => showView("analysis"));
$("settings-nav").addEventListener("click", () => showView("settings"));
$("account-nav").addEventListener("click", () => {
  $("user-menu-popover").hidden = true;
  showView("account");
});
$("account-selector-trigger").addEventListener("click", () => {
  $("account-selector-popover").hidden = !$("account-selector-popover").hidden;
});
$("add-account-button").addEventListener("click", () => {
  $("account-selector-popover").hidden = true;
  showView("onboarding");
});
$("manage-account-button").addEventListener("click", () => {
  $("account-selector-popover").hidden = true;
  showManageAccount();
});
document.querySelectorAll("[data-create-account-mode]").forEach((button) => {
  button.addEventListener("click", () => startCreateAccount(button.dataset.createAccountMode));
});
$("account-create-submit").addEventListener("click", createTradingAccount);
$("connect-test-button").addEventListener("click", testBinanceConnection);
$("connect-save-button").addEventListener("click", saveBinanceConnection);
$("user-menu-trigger").addEventListener("click", () => {
  $("user-menu-popover").hidden = !$("user-menu-popover").hidden;
});
$("logout-button").addEventListener("click", logout);
$("delete-account-button").addEventListener("click", openDeleteAccountModal);
$("cancel-delete-account-button").addEventListener("click", closeDeleteAccountModal);
$("delete-account-confirm-input").addEventListener("input", updateDeleteAccountConfirmState);
$("confirm-delete-account-button").addEventListener("click", deleteActiveAccount);
$("view-all-events").addEventListener("click", openDecisionLogModal);
$("close-decision-log").addEventListener("click", closeDecisionLogModal);
$("event-symbol-filter").addEventListener("change", (event) => {
  activityState.symbolFilter = event.target.value;
  renderDecisionLogModal();
});
$("event-type-filter").addEventListener("change", (event) => {
  activityState.typeFilter = event.target.value;
  renderDecisionLogModal();
});
$("show-register").addEventListener("click", () => showAuthForm("register"));
$("show-login").addEventListener("click", () => showAuthForm("login"));
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  login();
});
$("register-form").addEventListener("submit", (event) => {
  event.preventDefault();
  register();
});
window.addEventListener("resize", () => resizeChart());
window.addEventListener("auth:unauthorized", () => {
  showLoggedOut();
  setStatus("login-message", "Please login to continue");
});
$("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
});
// Without a saved choice the page keeps following the OS setting.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  if (!localStorage.getItem(THEME_STORAGE_KEY)) applyTheme(event.matches ? "dark" : "light");
});
document.querySelectorAll(".positions-table").forEach((table) => {
  labelTableCells(table);
  new MutationObserver(() => labelTableCells(table)).observe(table, { childList: true, subtree: true });
});
// Polls skip while the tab is hidden; refresh at once when it comes back.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (activeView === "home" && authState.dashboardTimer) pollHomeOnce();
  if (activeView === "chart" && chartState.timer) pollChartOnce();
});

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
boot();

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  $("theme-toggle").setAttribute("aria-label", label);
  $("theme-toggle").title = label;
  chartState.instance?.applyTheme();
}

// Copies each column header onto its cells so narrow screens can show rows as labelled cards.
function labelTableCells(table) {
  const labels = [...table.querySelectorAll("thead th")].map((cell) => cell.textContent.trim());
  table.querySelectorAll("tbody tr").forEach((row) => {
    [...row.cells].forEach((cell, index) => {
      const label = labels[index] ?? "";
      if (cell.dataset.label !== label) cell.dataset.label = label;
    });
  });
}

// Colours a status line from its wording, so callers keep passing plain text.
function statusTone(text) {
  const value = String(text ?? "");
  if (/fail|error|required|must|cannot|invalid|not match|unavailable|offline|please login/i.test(value)) return "error";
  if (/\b(loading|creating|testing|saving|deleting|analyzing|recovering)\b|unsaved/i.test(value)) return "pending";
  if (/^(saved|loaded)$|\b(saved|updated)$/i.test(value)) return "ok";
  return "";
}

function setStatus(id, text, tone = statusTone(text)) {
  const element = $(id);
  element.textContent = text;
  element.dataset.tone = tone;
}

async function boot() {
  try {
    const response = await apiFetch("/api/auth/me");
    if (response.ok) {
      const payload = await response.json();
      showLoggedIn(payload.user);
      return;
    }
  } catch {
    // Keep login visible when the API is temporarily unavailable.
  }
  showLoggedOut();
}

async function login() {
  await submitAuth({
    form: "login",
    path: "/api/auth/login",
    payload: {
      email: $("login-email").value,
      password: $("login-password").value,
    },
  });
}

async function register() {
  const password = $("register-password").value;
  if (password !== $("register-confirm-password").value) {
    setStatus("register-message", "Passwords do not match");
    return;
  }

  await submitAuth({
    form: "register",
    path: "/api/auth/register",
    payload: {
      email: $("register-email").value,
      password,
    },
  });
}

async function submitAuth({ form, path, payload }) {
  const submit = $(`${form}-submit`);
  const messageId = `${form}-message`;
  submit.disabled = true;
  setStatus(messageId, "Loading");

  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(body.error ?? `Authentication failed: ${response.status}`);
    setStatus(messageId, "");
    showLoggedIn(body.user);
  } catch (error) {
    setStatus(messageId, error instanceof Error ? error.message : String(error));
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  $("logout-button").disabled = true;
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    $("logout-button").disabled = false;
    showLoggedOut();
  }
}

function showLoggedIn(user) {
  authState.user = user;
  $("auth-view").hidden = true;
  document.querySelector(".nav-tabs").hidden = true;
  $("account-selector").hidden = true;
  $("user-menu").hidden = true;
  $("user-menu-trigger").textContent = `${user?.email ?? "Account"} ▼`;
  renderAccount(user);
  initializeTradingAccounts();
}

function showLoggedOut() {
  $("boot-loader").hidden = true;
  authState.user = null;
  stopHomePolling();
  stopChartPolling();
  closeLiveStream();
  Object.assign(homeState, { snapshot: null, snapshotAt: 0 });
  settingsRequestSequence += 1;
  analysisRequestSequence += 1;
  dashboardRequestSequence += 1;
  activeView = null;
  $("auth-view").hidden = false;
  document.querySelector(".nav-tabs").hidden = true;
  $("account-selector").hidden = true;
  $("account-selector-popover").hidden = true;
  $("user-menu").hidden = true;
  $("user-menu-popover").hidden = true;
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  Object.assign(accountState, {
    accounts: [],
    activeAccount: null,
    pendingMode: null,
    testedCredentials: null,
    lastConnection: null,
    lastBinanceAccount: null,
  });
}

function showAuthForm(form) {
  $("login-form").hidden = form !== "login";
  $("register-form").hidden = form !== "register";
  setStatus("login-message", "");
  setStatus("register-message", "");
}

function renderAccount(user) {
  $("account-email").textContent = user?.email ?? "-";
  $("account-id").textContent = user?.id ?? "-";
  $("account-created-at").textContent = user?.createdAt ? new Date(user.createdAt).toLocaleString() : "-";
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function handleUnauthorized(response) {
  if (response.status !== 401) return false;
  showLoggedOut();
  setStatus("login-message", "Please login to continue");
  return true;
}

async function initializeTradingAccounts() {
  try {
    await refreshTradingAccounts();
    if (accountState.accounts.length === 0) {
      $("account-selector").hidden = true;
      $("user-menu").hidden = false;
      showView("onboarding");
      return;
    }

    setActiveTradingAccount(accountState.accounts[0]);
    restoreWorkspaceInputs(accountState.accounts[0].id);
    showView(getStoredMainView());
    document.querySelector(".nav-tabs").hidden = false;
    $("account-selector").hidden = false;
    $("user-menu").hidden = false;
    // Warm the chart library once the first view is up, so opening Chart later is instant.
    whenIdle(() => loadChartLibrary().catch(() => {}));
  } catch (error) {
    setStatus("login-message", error instanceof Error ? error.message : String(error));
    showLoggedOut();
  }
}

async function refreshTradingAccounts() {
  const response = await apiFetch("/api/trading-accounts");
  if (handleUnauthorized(response)) return;
  if (!response.ok) throw new Error(`Trading accounts request failed: ${response.status}`);
  accountState.accounts = (await response.json()).accounts ?? [];
}

function renderAccountSelector() {
  const account = accountState.activeAccount;
  $("account-selector-trigger").textContent = account ? `${account.name} ▼` : "Select Account";
  $("account-selector-list").replaceChildren(
    ...accountState.accounts.map((item) => {
      const button = document.createElement("button");
      button.className = "account-selector-row";
      button.type = "button";
      button.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${item.mode}</span>`;
      button.addEventListener("click", async () => {
        $("account-selector-popover").hidden = true;
        setActiveTradingAccount(item);
      });
      return button;
    }),
  );
}

// Only the visible view fetches: Home gets everything from the snapshot, and Settings,
// Manage Account and Connect load their own data when opened.
function setActiveTradingAccount(account) {
  accountState.activeAccount = account;
  chartState.instance?.cancelPendingLoad();
  // The home cards still show the previous account until its first snapshot arrives.
  $("home-view").dataset.loading = "true";
  setHomeAlert(null);
  Object.assign(homeState, { snapshot: null, snapshotAt: 0 });
  openLiveStream(account.id);
  Object.assign(settingsState, defaultSettings);
  Object.assign(realSafetyState, { mode: "LOCKED", masterLiveExecutionEnabled: false, proposals: [] });
  renderAccountSelector();
  renderSettings();
  restoreWorkspaceInputs(account.id);
  dashboardRequestSequence += 1;
  if (activeView === "chart") loadChart();
  if (activeView === "analysis") loadAnalysis();
  if (activeView === "settings") loadSettings(account.id);
  if (activeView === "home") pollHomeOnce();
}

function startCreateAccount(mode) {
  accountState.pendingMode = mode === "REAL" ? "REAL" : "DEMO";
  $("account-create-title").textContent = accountState.pendingMode === "REAL" ? "Create Real Account" : "Create Demo Account";
  $("account-create-environment").textContent = accountEnvironmentLabel(accountState.pendingMode);
  $("account-create-name").value = accountState.pendingMode === "REAL" ? "My Binance" : "My Testnet";
  setStatus("account-create-message", "");
  showView("account-create");
}

async function createTradingAccount() {
  const mode = accountState.pendingMode ?? "DEMO";
  $("account-create-submit").disabled = true;
  setStatus("account-create-message", "Creating");
  try {
    const response = await apiFetch("/api/trading-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("account-create-name").value, mode }),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(body.error ?? `Create account failed: ${response.status}`);
    await refreshTradingAccounts();
    accountState.activeAccount = body.account;
    accountState.pendingMode = null;
    $("account-selector").hidden = false;
    renderAccountSelector();
    openConnectView();
  } catch (error) {
    setStatus("account-create-message", error instanceof Error ? error.message : String(error));
  } finally {
    $("account-create-submit").disabled = false;
  }
}

function openConnectView() {
  const account = accountState.activeAccount;
  if (!account) return;
  $("connect-account-label").textContent = `Account: ${account.name}`;
  $("connect-environment-label").textContent = `Environment: ${accountEnvironmentLabel(account.mode)}`;
  $("real-connection-warning").hidden = account.mode !== "REAL";
  $("connect-api-key").value = "";
  $("connect-api-secret").value = "";
  $("connect-save-button").disabled = true;
  $("connect-status").textContent = "Connection Status: Not connected";
  setStatus("connect-message", "");
  accountState.testedCredentials = null;
  showView("connect");
}

async function testBinanceConnection() {
  const account = accountState.activeAccount;
  if (!account) return;
  const credentials = { apiKey: $("connect-api-key").value, apiSecret: $("connect-api-secret").value };
  $("connect-test-button").disabled = true;
  setStatus("connect-message", "Testing connection");
  try {
    const response = await apiFetch(`/api/trading-accounts/${account.id}/binance-connection/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(body.error ?? `Connection test failed: ${response.status}`);
    accountState.testedCredentials = credentials;
    accountState.lastConnection = body.connection;
    accountState.lastBinanceAccount = body.account;
    $("connect-api-secret").value = "";
    $("connect-save-button").disabled = false;
    $("connect-status").textContent = `✓ ${accountEnvironmentLabel(account.mode)} connected · ${body.connection.apiKeyMasked} · Wallet ${formatUsdt(body.account.walletBalance)}`;
    setStatus("connect-message", "");
  } catch (error) {
    accountState.testedCredentials = null;
    $("connect-save-button").disabled = true;
    setStatus("connect-message", error instanceof Error ? error.message : String(error));
  } finally {
    $("connect-test-button").disabled = false;
  }
}

async function saveBinanceConnection() {
  const account = accountState.activeAccount;
  if (!account || !accountState.testedCredentials) return;
  $("connect-save-button").disabled = true;
  setStatus("connect-message", "Saving connection");
  try {
    const response = await apiFetch(`/api/trading-accounts/${account.id}/binance-connection`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(accountState.testedCredentials),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(body.error ?? `Save connection failed: ${response.status}`);
    accountState.lastConnection = body.connection;
    accountState.lastBinanceAccount = body.account;
    accountState.testedCredentials = null;
    await refreshTradingAccounts();
    accountState.activeAccount = accountState.accounts.find((item) => item.id === account.id) ?? account;
    renderAccountSelector();
    showView("home");
  } catch (error) {
    setStatus("connect-message", error instanceof Error ? error.message : String(error));
    $("connect-save-button").disabled = false;
  }
}

async function loadActiveAccountStatus() {
  const account = accountState.activeAccount;
  if (!account) return;
  const [connectionResponse, accountResponse] = await Promise.all([
    apiFetch(`/api/trading-accounts/${account.id}/binance-connection`),
    apiFetch(`/api/trading-accounts/${account.id}/binance-account`),
  ]);
  if (handleUnauthorized(connectionResponse) || handleUnauthorized(accountResponse)) return;
  accountState.lastConnection = connectionResponse.ok ? (await connectionResponse.json()).connection : null;
  accountState.lastBinanceAccount = accountResponse.ok ? (await accountResponse.json()).account : null;
}

async function showManageAccount() {
  const account = accountState.activeAccount;
  if (!account) return;
  await loadActiveAccountStatus();
  renderManageAccount();
  showView("account-manage");
}

function renderManageAccount() {
  const account = accountState.activeAccount;
  const connection = accountState.lastConnection;
  $("manage-account-name").textContent = account?.name ?? "-";
  $("manage-account-id").textContent = account?.id ?? "-";
  $("manage-account-mode").textContent = account?.mode ?? "-";
  $("manage-account-environment").textContent = account ? accountEnvironmentLabel(account.mode) : "-";
  $("manage-connection-status").textContent = connection?.status ?? "NOT_CONFIGURED";
  $("manage-connection-detail").textContent = connection?.apiKeyMasked ?? "No API key saved";
  $("manage-account-status").textContent = account ? `${account.name} · ${accountEnvironmentLabel(account.mode)}` : "No account selected";
  $("delete-account-message").textContent = "";
}

function openDeleteAccountModal() {
  const account = accountState.activeAccount;
  if (!account) return;
  $("delete-account-warning").textContent = `Delete "${account.name}" (${account.mode}) permanently from the bot. Account-scoped settings, watchlist, credentials, execution records, audit events, and bot records will be removed.`;
  $("delete-account-real-warning").hidden = account.mode !== "REAL";
  $("delete-account-confirm-label").textContent = `Type "${account.name}" to confirm`;
  $("delete-account-confirm-input").value = "";
  setStatus("delete-account-confirm-message", "");
  $("confirm-delete-account-button").disabled = true;
  $("delete-account-modal").hidden = false;
  $("delete-account-confirm-input").focus();
}

function closeDeleteAccountModal() {
  $("delete-account-modal").hidden = true;
  $("confirm-delete-account-button").disabled = false;
}

function updateDeleteAccountConfirmState() {
  const account = accountState.activeAccount;
  $("confirm-delete-account-button").disabled = !account || $("delete-account-confirm-input").value !== account.name;
}

async function deleteActiveAccount() {
  const account = accountState.activeAccount;
  if (!account || $("delete-account-confirm-input").value !== account.name) return;
  $("confirm-delete-account-button").disabled = true;
  $("cancel-delete-account-button").disabled = true;
  setStatus("delete-account-confirm-message", "Deleting account");
  stopHomePolling();
  stopChartPolling();
  settingsRequestSequence += 1;
  analysisRequestSequence += 1;
  dashboardRequestSequence += 1;

  try {
    const response = await apiFetch(`/api/trading-accounts/${account.id}`, { method: "DELETE" });
    const body = response.status === 204 ? {} : await safeJson(response);
    if (!response.ok) throw new Error(body.code === "ACCOUNT_HAS_ACTIVE_TRADING_STATE" ? body.code : body.error ?? `Delete account failed: ${response.status}`);
    closeDeleteAccountModal();
    await handleDeletedAccount(account.id);
  } catch (error) {
    setStatus("delete-account-confirm-message", error instanceof Error ? error.message : String(error));
    $("confirm-delete-account-button").disabled = $("delete-account-confirm-input").value !== account.name;
  } finally {
    $("cancel-delete-account-button").disabled = false;
  }
}

async function handleDeletedAccount(deletedAccountId) {
  closeLiveStream();
  accountState.activeAccount = null;
  accountState.lastConnection = null;
  accountState.lastBinanceAccount = null;
  accountState.testedCredentials = null;
  await refreshTradingAccounts();
  accountState.accounts = accountState.accounts.filter((item) => item.id !== deletedAccountId);
  renderAccountSelector();
  if (accountState.accounts.length === 0) {
    $("account-selector").hidden = true;
    showView("onboarding");
    return;
  }
  $("account-selector").hidden = false;
  setActiveTradingAccount(accountState.accounts[0]);
  showView("home");
}

function accountEnvironmentLabel(mode) {
  return mode === "REAL" ? "REAL · MAINNET · EXECUTION LOCKED" : "DEMO · TESTNET";
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

async function load() {
  const accountId = accountState.activeAccount?.id;
  if (!accountId) return;
  const sequence = ++dashboardRequestSequence;
  const snapshotResponse = await apiFetch(`/api/trading-accounts/${accountId}/snapshot`);
  if (sequence !== dashboardRequestSequence || accountId !== accountState.activeAccount?.id || activeView !== "home") return;
  if (handleUnauthorized(snapshotResponse)) return;
  if (!snapshotResponse.ok) throw await responseError(snapshotResponse, "Snapshot request");
  const snapshot = await snapshotResponse.json();
  if (sequence !== dashboardRequestSequence || accountId !== accountState.activeAccount?.id || activeView !== "home") return;
  homeState.snapshot = snapshot;
  homeState.snapshotAt = Date.now();
  delete $("home-view").dataset.loading;
  setHomeAlert(null);
  renderHome();
}

// Home = the last full snapshot (balances and daily risk, polled) overlaid with the live stream's monitor and store.
function renderHome() {
  const base = homeState.snapshot;
  if (!base && !liveState.monitor && !liveState.store) return;
  const snapshot = { ...(base ?? {}), ...(liveState.monitor ?? {}), ...(liveState.store ?? {}) };
  const engine = snapshot.engine ?? {};
  const runtime = snapshot.runtime ?? {};
  const store = snapshot.store ?? {};
  const runtimeHealth = snapshot.runtimeHealth ?? {};
  // Account cards wait for a real snapshot instead of showing "DISCONNECTED" from missing data.
  if (base) renderAccountCards(base);

  $("engine-state").textContent = engine.setupState ?? "-";
  const execution = snapshot.execution ?? runtimeHealth.execution ?? {
    enabled: Boolean(runtimeHealth.executionEnabled),
    reason: runtimeHealth.executionEnabled ? "READY" : "RECONCILIATION_REQUIRED",
  };
  const executionLabel = execution.enabled ? "ENABLED" : "DISABLED";
  const executionReason = execution.reason ? ` · ${execution.reason}` : "";
  const realReadiness = snapshot.realReadiness ?? null;
  const protectionLine = runtimeHealth.protectionStatus && runtimeHealth.protectionStatus !== "OK"
    ? `Protection ${runtimeHealth.protectionStatus} · Repair attempts ${runtimeHealth.protectionRepairAttempts ?? 0}${runtimeHealth.protectionLastError ? ` · ${runtimeHealth.protectionLastError}` : ""}`
    : "Protection PROTECTED/VERIFIED";
  // One fact per line: the Engine card renders these with white-space: pre-line.
  $("engine-detail").textContent = [
    `Runtime ${runtimeHealth.state ?? "-"} · Reconciliation ${runtimeHealth.reconciliationStatus ?? "-"}`,
    `Execution ${executionLabel}${executionReason}`,
    ...(realReadiness
      ? [
          `Mode ${realReadiness.realExecutionMode} · Account readiness ${realReadiness.accountReady ? "READY" : "NOT READY"}`,
          `Master Live Execution ${realReadiness.masterLiveExecutionEnabled ? "UNLOCKED" : "LOCKED BY SERVER"} · Execution LOCKED · ${realReadiness.executionReason}`,
        ]
      : []),
    ...(runtimeHealth.lastReconciliationError ? [`Error ${runtimeHealth.lastReconciliationError}`] : []),
    protectionLine,
    `Risk 1R ${formatUsdt(runtime.risk?.riskPerTradeUsdt)} · Max leverage ${runtime.risk?.maxLeverage ?? "-"}x`,
  ].join("\n");

  $("trend").textContent = engine.trend ?? "-";
  $("symbol").textContent = runtime.symbol ?? "-";
  const htfFvg = store.currentHtfFvg ?? store.currentFvg;
  $("fvg").textContent = htfFvg
    ? `${htfFvg.direction} ${htfFvg.status}`
    : "-";
  $("fvg-detail").textContent = htfFvg
    ? `${formatPrice(htfFvg.lower)} - ${formatPrice(htfFvg.upper)} · ${String(htfFvg.status ?? "-").toUpperCase()}`
    : "No active HTF FVG";

  activityState.events = Array.isArray(store.events) ? store.events : [];
  renderRecentActivities();
  if (!$("decision-log-modal").hidden) {
    renderDecisionLogFilters();
    renderDecisionLogModal();
  }

  renderWatchlist(snapshot.watchlistRows ?? []);
}

function renderAccountCards(snapshot) {
  const runtime = snapshot.runtime ?? {};
  const account = snapshot.binanceAccount ?? runtime.account ?? {};
  const connection = snapshot.connection ?? {};
  const dailyRisk = snapshot.dailyRisk ?? null;
  const accountProtection = snapshot.accountProtection ?? null;
  accountState.lastConnection = connection;
  accountState.lastBinanceAccount = account;
  const marketData = runtime.marketData ?? {};

  setHeroBadge(
    "account-pill",
    connection.status === "CONNECTED" || account.connected ? "CONNECTED" : "DISCONNECTED",
    account.connected,
  );
  setHeroBadge(
    "network-pill",
    accountState.activeAccount ? `${accountState.activeAccount.mode} · ${account.environment ?? "-"}` : String(account.environment ?? "-").toUpperCase(),
    connection.status === "CONNECTED" || account.connected,
  );

  $("account").textContent = account.connected ? "Connected" : "Not connected";
  $("account-detail").textContent =
    accountState.activeAccount ? `${accountState.activeAccount.name} · ${connection.apiKeyMasked ?? "No API key saved"}` : `${account.environment ?? "-"} · ${account.label ?? "-"}`;
  $("wallet-balance").textContent = formatUsdt(account.walletBalance);
  $("available-balance").textContent = formatUsdt(account.availableBalance);
  $("connect-binance-button").hidden = connection.status === "CONNECTED";

  $("market-data").textContent = marketData.connected ? "Connected" : "Offline";
  $("market-data-detail").textContent = marketData.label ?? "-";

  $("daily-entry-status").textContent = dailyRisk ? dailyEntryStatusLabel(dailyRisk) : "-";
  $("daily-risk-detail").textContent = dailyRisk
    ? `Today Realized PnL: ${formatSignedNumber(dailyRisk.realizedR)}R (${formatSignedUsdt(dailyRisk.realizedPnlUsdt)})\nDaily Range: -${dailyRisk.dailyLossLimitR}R → +${dailyRisk.dailyProfitLimitR}R`
    : "Daily status unavailable";
  $("account-protection-status").textContent = accountProtection ? accountProtectionStatusLabel(accountProtection) : "-";
  $("account-protection-detail").textContent = accountProtection
    ? `Current Drawdown: ${formatSignedNumber(accountProtection.drawdownPercent)}%\nMax Drawdown: ${accountProtection.maxDrawdownPercent}%`
    : "Account protection unavailable";
}

function renderRecentActivities() {
  const recent = [...activityState.events].toReversed().slice(0, 8);
  $("event-count").textContent = `${recent.length} recent · ${activityState.events.length} total`;
  $("view-all-events").disabled = activityState.events.length === 0;
  $("events").replaceChildren(
    ...(recent.length > 0 ? recent.map((event) => eventListItem(event, { compact: true })) : [emptyEventItem("No recent activities")]),
  );
}

function openDecisionLogModal() {
  activityState.symbolFilter = "all";
  activityState.typeFilter = "all";
  renderDecisionLogFilters();
  renderDecisionLogModal();
  $("decision-log-modal").hidden = false;
}

function closeDecisionLogModal() {
  $("decision-log-modal").hidden = true;
}

function renderDecisionLogFilters() {
  fillSelect("event-symbol-filter", ["all", ...uniqueEventValues((event) => eventSymbol(event))], activityState.symbolFilter);
  fillSelect("event-type-filter", ["all", ...uniqueEventValues((event) => eventType(event))], activityState.typeFilter);
}

function renderDecisionLogModal() {
  const filtered = [...activityState.events]
    .toReversed()
    .filter((event) => activityState.symbolFilter === "all" || eventSymbol(event) === activityState.symbolFilter)
    .filter((event) => activityState.typeFilter === "all" || eventType(event) === activityState.typeFilter);
  $("decision-log-summary").textContent = `${filtered.length} shown · ${activityState.events.length} total`;
  $("all-events").replaceChildren(
    ...(filtered.length > 0
      ? filtered.map((event) => eventListItem(event, { compact: false }))
      : [emptyEventItem("No events match the selected filters")]),
  );
}

function fillSelect(id, values, selected) {
  const select = $(id);
  const selectedValue = values.includes(selected) ? selected : "all";
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "all" ? "All" : value;
      option.selected = value === selectedValue;
      return option;
    }),
  );
  if (selectedValue !== selected) {
    if (id === "event-symbol-filter") activityState.symbolFilter = selectedValue;
    if (id === "event-type-filter") activityState.typeFilter = selectedValue;
  }
}

function uniqueEventValues(selector) {
  return [...new Set(activityState.events.map(selector).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function eventListItem(event, options) {
  const item = document.createElement("li");
  item.className = options.compact ? "activity-item compact" : "activity-item";
  const titleRow = document.createElement("div");
  titleRow.className = "activity-title-row";
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const detail = document.createElement("code");
  title.textContent = eventType(event);
  meta.textContent = [eventSymbol(event), eventTimestamp(event)].filter(Boolean).join(" · ");
  detail.textContent = eventDescription(event);
  titleRow.append(title, meta);
  item.append(titleRow, detail);
  return item;
}

function emptyEventItem(message) {
  const item = document.createElement("li");
  item.className = "activity-item";
  const detail = document.createElement("span");
  detail.textContent = message;
  item.append(detail);
  return item;
}

function eventType(event) {
  return String(event?.type ?? "UnknownEvent");
}

function eventSymbol(event) {
  return String(event?.symbol ?? event?.fvg?.symbol ?? event?.signal?.symbol ?? event?.decision?.symbol ?? "");
}

function eventTimestamp(event) {
  const timestamp = event?.at ?? event?.timestamp ?? event?.createdAt ?? null;
  return timestamp ? new Date(timestamp).toLocaleString() : "";
}

function eventDescription(event) {
  if (event?.reason) return String(event.reason);
  if (event?.decision?.reason) return String(event.decision.reason);
  if (event?.fvg) return `${event.fvg.direction ?? "-"} ${event.fvg.timeframe ?? "-"} FVG ${formatPrice(event.fvg.lower)} - ${formatPrice(event.fvg.upper)}`;
  if (event?.signal) return `${event.signal.type ?? "-"} ${event.signal.direction ?? "-"} at ${formatPrice(event.signal.close)}`;
  return JSON.stringify(event);
}

function startHomePolling() {
  stopHomePolling();
  pollHomeOnce();
  authState.dashboardTimer = setInterval(pollHomeOnce, HOME_POLL_INTERVAL_MS);
}

function stopHomePolling() {
  if (!authState.dashboardTimer) return;
  clearInterval(authState.dashboardTimer);
  authState.dashboardTimer = null;
  dashboardRequestSequence += 1;
}

function startChartPolling() {
  stopChartPolling();
  pollChartOnce();
  chartState.timer = setInterval(pollChartOnce, CHART_POLL_INTERVAL_MS);
}

function stopChartPolling() {
  if (chartState.timer) {
    clearInterval(chartState.timer);
    chartState.timer = null;
  }
  chartState.instance?.cancelPendingLoad();
}

function pollHomeOnce() {
  if (document.hidden) return;
  const accountId = accountState.activeAccount?.id;
  const stillCurrent = () => activeView === "home" && accountId === accountState.activeAccount?.id;
  const live = liveState.status === "live";
  if (!live || Date.now() - homeState.snapshotAt >= LIVE_SNAPSHOT_INTERVAL_MS) {
    load().catch((error) => {
      if (!stillCurrent()) return;
      // Nothing loaded yet for this account: stop the placeholders and say the connection state is unknown.
      if ($("home-view").dataset.loading) {
        setHeroBadge("account-pill", "UNAVAILABLE", false);
        if (!liveState.monitor) $("watchlist-body").replaceChildren(emptyTableRow("Scanner data unavailable", 7));
      }
      delete $("home-view").dataset.loading;
      setHomeAlert(userFacingApiError(error));
    });
  }
  // The live stream pushes AI decisions itself.
  if (live) return;
  loadAiDecisions().catch((error) => {
    if (!stillCurrent()) return;
    $("ai-decision-count").textContent = "Không tải được";
    $("ai-decisions-body").replaceChildren(emptyTableRow(`Không tải được quyết định AI · ${userFacingApiError(error)}`, 6, "error"));
  });
}

function openLiveStream(accountId) {
  closeLiveStream();
  if (!accountId || typeof EventSource === "undefined") {
    setLiveStatus("polling");
    return;
  }
  const source = new EventSource(apiUrl(`/api/trading-accounts/${accountId}/stream`), { withCredentials: true });
  liveState.source = source;
  liveState.accountId = accountId;
  setLiveStatus("connecting");
  const isCurrent = () => liveState.source === source;
  const on = (event, handler) => {
    source.addEventListener(event, (message) => {
      if (!isCurrent()) return;
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      handler(data);
    });
  };

  source.addEventListener("open", () => {
    if (isCurrent()) setLiveStatus("live");
  });
  source.addEventListener("error", () => {
    if (!isCurrent()) return;
    // Old live data must not cover fresher polled data while the stream is down.
    liveState.monitor = null;
    liveState.store = null;
    if (source.readyState === EventSource.CLOSED) {
      // The server refused the stream (runtime unavailable, signed out...): poll, and retry later.
      liveState.source = null;
      setLiveStatus("polling");
      liveState.retryTimer = setTimeout(() => {
        if (liveState.accountId === accountId && !liveState.source) openLiveStream(accountId);
      }, LIVE_RETRY_MS);
    } else {
      setLiveStatus("connecting");
    }
    if (activeView === "home") pollHomeOnce();
  });
  on("monitor", (data) => {
    liveState.monitor = data;
    renderHome();
  });
  on("store", (data) => {
    liveState.store = data;
    renderHome();
  });
  on("ai-decisions", (data) => renderAiDecisions(Array.isArray(data.decisions) ? data.decisions : []));
  on("ai-steps", (data) => {
    liveState.aiSteps = Array.isArray(data.steps) ? data.steps.slice(-AI_STEPS_KEPT) : [];
    renderAiSteps();
  });
  on("ai-step", (step) => {
    liveState.aiSteps = [...liveState.aiSteps, step].slice(-AI_STEPS_KEPT);
    renderAiSteps();
  });
  // A fresh scan changes Analysis and the chart overlays of that symbol.
  on("scanned", (data) => {
    const symbols = Array.isArray(data.symbols) ? data.symbols : [];
    if (activeView === "analysis" && symbols.includes(currentAnalysisSymbol())) loadAnalysis({ quiet: true });
    if (activeView === "chart" && symbols.includes(($("chart-symbol").value || DEFAULT_SYMBOL).trim().toUpperCase())) pollChartOnce();
  });
}

function closeLiveStream() {
  liveState.source?.close();
  if (liveState.retryTimer) clearTimeout(liveState.retryTimer);
  Object.assign(liveState, { source: null, accountId: null, retryTimer: null, monitor: null, store: null, aiSteps: [] });
  setLiveStatus("off");
  renderAiSteps();
}

function setLiveStatus(status) {
  liveState.status = status;
  const indicator = $("live-indicator");
  indicator.hidden = status === "off";
  indicator.dataset.state = status;
  $("live-label").textContent = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Polling";
  indicator.title =
    status === "live"
      ? "Realtime: dữ liệu được đẩy ngay khi bot quét xong"
      : status === "connecting"
        ? "Đang kết nối realtime…"
        : "Không có kết nối realtime, đang cập nhật mỗi 10 giây";
  if (status !== "live") renderAiSteps();
}

const AI_SCREEN_TEXT = {
  IN_FLIGHT: "đang chờ model trả lời lần trước",
  ALREADY_CONSULTED: "đã phân tích nến M5 này rồi",
  HAS_POSITION: "symbol đang có vị thế hoặc lệnh chờ",
  SETUP_ARCHIVED: "setup đã bị huỷ",
  TREND_NEUTRAL: "trend H1 trung tính",
  LOW_EVIDENCE: "setup chưa đủ điều kiện (cần ≥ 5/7 hoặc ReadyToEnter)",
};
const AI_GATE_TEXT = { rules: "quy tắc chiến lược", duplicate: "chống trùng lệnh", risk: "quản lý rủi ro" };

// What the AI advisor checked, asked, got back and decided, newest first.
function renderAiSteps() {
  const list = $("ai-steps");
  const steps = liveState.aiSteps;
  $("ai-steps-count").textContent = steps.length > 0 ? `${steps.length} bước gần nhất` : "Realtime";
  if (steps.length === 0) {
    const empty = document.createElement("li");
    empty.className = "ai-steps-empty";
    empty.textContent =
      liveState.status === "live"
        ? "Chưa có hoạt động AI. Bật Chế độ AI (ADVISORY hoặc AUTO) trong Setting: mỗi lần bot quét, AI sẽ báo đang kiểm tra gì và quyết định gì."
        : liveState.status === "connecting"
          ? "Đang kết nối realtime…"
          : "Cần kết nối realtime để xem AI đang làm gì.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...[...steps].reverse().map(aiStepItem));
}

function aiStepItem(step) {
  const view = aiStepView(step);
  const item = document.createElement("li");
  const head = document.createElement("div");
  const time = document.createElement("time");
  const symbol = document.createElement("strong");
  const text = document.createElement("p");
  item.className = "ai-step";
  item.dataset.stage = step.stage;
  head.className = "ai-step-head";
  time.textContent = new Date(step.at).toLocaleTimeString();
  symbol.textContent = step.symbol;
  text.className = "ai-step-text";
  text.textContent = view.text;
  head.append(time, symbol, badge(view.label, view.tone));
  item.append(head, text);
  if (view.quote) {
    const quote = document.createElement("blockquote");
    quote.textContent = view.quote;
    item.append(quote);
  }
  return item;
}

function aiStepView(step) {
  if (step.stage === "screen") {
    // An archived setup has no live evidence (Bot Monitor shows 0/7), so its count is left out.
    const evidence = step.skip === "SETUP_ARCHIVED" ? "" : ` · ${step.evidence}/7 điều kiện`;
    return {
      label: "Kiểm tra",
      tone: "",
      text: `${step.setupState}${evidence} · trend ${step.trend} → chưa hỏi AI: ${AI_SCREEN_TEXT[step.skip] ?? step.skip}`,
    };
  }
  if (step.stage === "analyze") {
    return {
      label: "Đang phân tích",
      tone: "info",
      text: `Gửi cho ${step.model} (${step.mode}): trend ${step.trend}, ${step.setupState}, ${step.evidence}/7 điều kiện, giá ${step.livePrice === null ? "-" : formatPrice(step.livePrice)}`,
    };
  }
  if (step.stage === "answer") {
    const decision = step.decision ?? {};
    const confidence = Number.isFinite(Number(decision.confidence)) ? `${Math.round(Number(decision.confidence) * 100)}%` : "-";
    const side = decision.direction === "bullish" ? "LONG" : decision.direction === "bearish" ? "SHORT" : "";
    const seconds = `${(Number(step.latencyMs ?? 0) / 1000).toFixed(1)}s`;
    return {
      label: "AI trả lời",
      tone: "accent",
      text:
        decision.action === "ENTER"
          ? `Đề xuất VÀO LỆNH ${side} · tin cậy ${confidence} · Entry ${formatPrice(decision.entry)} · SL ${formatPrice(decision.stopLoss)} · TP ${formatPrice(decision.takeProfit)} (${seconds})`
          : `Đề xuất KHÔNG vào lệnh · tin cậy ${confidence} (${seconds})`,
      quote: decision.reason || "",
    };
  }
  if (step.stage === "check") {
    const gate = AI_GATE_TEXT[step.gate] ?? step.gate;
    return step.ok
      ? { label: "Đạt", tone: "ok", text: `Kiểm tra ${gate}: đạt${step.riskReward ? ` · R/R ${formatRatio(step.riskReward)}` : ""}` }
      : { label: "Bị chặn", tone: "danger", text: `Kiểm tra ${gate}: không đạt (${step.code ?? "-"})${step.reason ? ` · ${step.reason}` : ""}` };
  }
  return aiResultView(step);
}

function aiResultView(step) {
  const reason = step.rejectReason ? ` · ${step.rejectReason}` : "";
  if (step.outcome === "SUBMITTED") return { label: "Quyết định", tone: "ok", text: `VÀO LỆNH: đã đặt lệnh${step.executionIntentId ? ` (${step.executionIntentId})` : ""}` };
  if (step.outcome === "ADVISORY") return { label: "Quyết định", tone: "ok", text: `Nên vào lệnh: chỉ ghi lại vì đang ở chế độ ADVISORY${reason}` };
  if (step.outcome === "SKIPPED") return { label: "Quyết định", tone: "", text: "Không vào lệnh" };
  if (step.outcome === "REJECTED") return { label: "Quyết định", tone: "danger", text: `Không vào lệnh: bị chặn bởi ${step.rejectCode ?? "-"}${reason}` };
  if (step.outcome === "EXECUTION_FAILED") return { label: "Quyết định", tone: "danger", text: `Đặt lệnh lỗi${reason}` };
  return { label: "Lỗi AI", tone: "warn", text: `Không có quyết định (${step.rejectCode ?? "LLM_ERROR"})${reason}` };
}

function setHomeAlert(message) {
  $("home-alert").hidden = !message;
  $("home-alert-text").textContent = message ?? "";
}

async function responseError(response, label) {
  const body = await safeJson(response);
  const detail = body.message ?? (typeof body.error === "string" ? body.error : "");
  return new Error(`${label} failed: ${response.status}${detail ? ` · ${detail}` : ""}`);
}

async function loadAiDecisions() {
  const accountId = accountState.activeAccount?.id;
  if (!accountId) return;
  const response = await apiFetch(`/api/trading-accounts/${accountId}/ai-decisions?limit=20`);
  if (accountId !== accountState.activeAccount?.id || activeView !== "home") return;
  if (handleUnauthorized(response)) return;
  if (!response.ok) throw await responseError(response, "AI decisions request");
  const body = await response.json();
  renderAiDecisions(Array.isArray(body.decisions) ? body.decisions : []);
}

function renderAiDecisions(decisions) {
  $("ai-decision-count").textContent = `${decisions.length} decisions`;
  if (decisions.length === 0) {
    $("ai-decisions-body").replaceChildren(emptyTableRow("Chưa có quyết định AI", 6));
    return;
  }
  $("ai-decisions-body").replaceChildren(
    ...decisions.map((decision) => {
      const row = document.createElement("tr");
      const direction = decision.decision?.direction;
      const confidence = Number(decision.decision?.confidence);
      row.className = `position-row ${direction === "bullish" ? "long" : direction === "bearish" ? "short" : ""}`;
      row.append(
        dateTimeCell(decision.createdAt),
        symbolCell(decision.symbol),
        aiActionCell(decision.decision?.action, direction),
        Number.isFinite(confidence) ? meterCell(confidence, `${Math.round(confidence * 100)}%`) : tableCell("-"),
        aiResultCell(aiDecisionResult(decision)),
        reasonCell(decision.decision?.reason || decision.rejectReason || "-"),
      );
      return row;
    }),
  );
}

// accepted = passed the bot's validation; the outcome says what happened next.
function aiDecisionResult(decision) {
  const code = decision.rejectCode ?? "";
  const reason = decision.rejectReason ?? "";
  if (decision.outcome === "SUBMITTED") return { label: "Đã đặt lệnh", tone: "ok", note: decision.executionIntentId ?? "", title: decision.executionIntentId ?? "" };
  if (decision.outcome === "ADVISORY") return { label: "Chấp nhận (advisory)", tone: "ok", note: code, title: reason };
  if (decision.outcome === "SKIPPED") return { label: "AI bỏ qua", tone: "", note: "", title: "" };
  if (decision.outcome === "LLM_ERROR") return { label: "Lỗi AI", tone: "warn", note: code, title: reason };
  if (decision.outcome === "EXECUTION_FAILED") return { label: "Đặt lệnh lỗi", tone: "danger", note: "", title: reason };
  return { label: "Từ chối", tone: "danger", note: code, title: reason };
}

function aiActionCell(action, direction) {
  const cell = document.createElement("td");
  if (!action) {
    cell.textContent = "-";
    return cell;
  }
  cell.append(badge(action, action === "ENTER" ? "accent" : ""));
  if (direction === "bullish" || direction === "bearish") {
    const side = document.createElement("span");
    side.className = `direction ${direction === "bullish" ? "long" : "short"}`;
    side.textContent = `${direction === "bullish" ? "▲" : "▼"} ${direction}`;
    cell.append(side);
  }
  return cell;
}

function aiResultCell(result) {
  const cell = document.createElement("td");
  cell.append(badge(result.label, result.tone));
  if (result.note) cell.append(cellNote(result.note));
  if (result.title) cell.title = result.title;
  return cell;
}

function reasonCell(text) {
  const cell = document.createElement("td");
  const body = document.createElement("div");
  cell.className = "cell-wrap";
  cell.title = text;
  body.className = "clamp";
  body.textContent = text;
  cell.append(body);
  return cell;
}

function dateTimeCell(value) {
  if (!value) return tableCell("-");
  const date = new Date(value);
  const cell = document.createElement("td");
  const time = document.createElement("strong");
  const day = document.createElement("span");
  time.textContent = date.toLocaleTimeString();
  day.textContent = date.toLocaleDateString();
  cell.title = date.toLocaleString();
  cell.append(time, day);
  return cell;
}

function symbolCell(symbol) {
  const cell = document.createElement("td");
  const name = document.createElement("strong");
  name.textContent = symbol ?? "-";
  cell.append(name);
  return cell;
}

// Small horizontal bar plus the number, used for AI confidence and passed setup conditions.
function meterCell(ratio, text, tone = "") {
  const cell = document.createElement("td");
  const meter = document.createElement("span");
  const fill = document.createElement("span");
  const value = document.createElement("span");
  meter.className = "meter";
  if (tone) meter.dataset.tone = tone;
  fill.className = "meter-fill";
  fill.style.width = `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`;
  value.className = "meter-value";
  value.textContent = text;
  meter.append(fill);
  cell.append(meter, value);
  return cell;
}

function badge(text, tone = "") {
  const element = document.createElement("span");
  element.className = "badge";
  if (tone) element.dataset.tone = tone;
  element.textContent = text;
  return element;
}

function cellNote(text) {
  const note = document.createElement("small");
  note.className = "cell-note";
  note.textContent = text;
  return note;
}

function emptyTableRow(message, colSpan, tone = "") {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.className = "empty-position";
  cell.colSpan = colSpan;
  cell.textContent = message;
  if (tone) cell.dataset.tone = tone;
  row.append(cell);
  return row;
}

function pollChartOnce() {
  if (document.hidden) return;
  loadChart().catch((error) => {
    if (activeView === "chart") setStatus("chart-status", userFacingApiError(error));
  });
}

function userFacingApiError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("503")) return "Bot runtime is recovering. Please wait.";
  if (message.includes("Failed to fetch")) return "API is offline. Reconnecting...";
  return message;
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

function formatSignedUsdt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

function formatSignedNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function dailyEntryStatusLabel(dailyRisk) {
  if (!dailyRisk?.newEntriesAllowed && dailyRisk?.blockReason === "DAILY_PROFIT_LIMIT_REACHED") return "Daily Profit Limit Reached";
  if (!dailyRisk?.newEntriesAllowed && dailyRisk?.blockReason === "DAILY_LOSS_LIMIT_REACHED") return "Daily Loss Limit Reached";
  return dailyRisk?.newEntriesAllowed ? "Trading Allowed" : "Daily Status Unavailable";
}

function accountProtectionStatusLabel(accountProtection) {
  if (!accountProtection?.newEntriesAllowed && accountProtection?.blockReason === "MAX_DRAWDOWN_REACHED") return "MAX DRAWDOWN REACHED";
  return accountProtection?.newEntriesAllowed ? "OK" : "Unavailable";
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatQuantity(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatRatio(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value)))
    return "-";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function renderWatchlist(rows) {
  $("watchlist-count").textContent = `${rows.length} symbols`;
  if (rows.length === 0) {
    $("watchlist-body").replaceChildren(emptyTableRow("Waiting for scanner", 7));
    return;
  }

  $("watchlist-body").replaceChildren(
    ...rows.map((item) => {
      const row = document.createElement("tr");
      row.className = `position-row ${item.position === "LONG" ? "long" : item.position === "SHORT" ? "short" : ""}`;
      row.append(
        symbolCell(item.symbol),
        tableCell(item.state),
        conditionsCell(item.conditions),
        tableCell(item.rr === null || item.rr === undefined ? "-" : formatRatio(item.rr)),
        positionCell(item.position),
        statusCell(item),
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

// Conditions arrive as "passed/total" (e.g. "5/7").
function conditionsCell(conditions) {
  const match = /^(\d+)\/(\d+)$/.exec(String(conditions ?? ""));
  if (!match || Number(match[2]) === 0) return tableCell(conditions === undefined || conditions === null ? "—" : conditions);
  const ratio = Number(match[1]) / Number(match[2]);
  return meterCell(ratio, conditions, ratio >= 1 ? "ok" : "");
}

function positionCell(position) {
  const cell = document.createElement("td");
  if (!position || position === "None") {
    const none = document.createElement("span");
    none.className = "muted-value";
    none.textContent = position ?? "-";
    cell.append(none);
    return cell;
  }
  const tone = position === "LONG" ? "ok" : position === "SHORT" ? "danger" : "info";
  cell.append(badge(position, tone));
  return cell;
}

function watchlistStatusTone(status) {
  if (status.startsWith("Blocked")) return "warn";
  if (status === "Ready") return "ok";
  if (status === "Active" || status === "Simulated") return "info";
  if (status === "Invalidated") return "danger";
  return "";
}

// Explains why a 7/7 setup did not become an order (risk gate, disabled trading, live price...).
function statusCell(item) {
  const status = String(item.status ?? "-");
  const cell = document.createElement("td");
  // "Blocked: CODE" shows as "Blocked"; the reason line below already carries the code.
  cell.append(badge(item.blockedReason && status.startsWith("Blocked") ? "Blocked" : status, watchlistStatusTone(status)));
  if (item.blockedReason) {
    cell.title = `${status}\n${item.blockedReason}`;
    cell.classList.add("cell-wrap");
    const reason = document.createElement("div");
    reason.className = "status-blocked-reason";
    reason.textContent = item.blockedReason;
    cell.append(reason);
  }
  return cell;
}

$("connect-binance-button").addEventListener("click", openConnectView);
$("chart-refresh").addEventListener("click", loadChart);
$("chart-symbol").addEventListener("change", loadChart);
$("chart-interval").addEventListener("change", loadChart);
$("analysis-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadAnalysis();
});
$("settings-save").addEventListener("click", saveSettings);
$("settings-reset").addEventListener("click", resetSettings);
$("real-proposal-status-filter").addEventListener("change", () => loadRealProposals());
document.querySelectorAll("[data-real-execution-mode]").forEach((button) => {
  button.addEventListener("click", () => changeRealExecutionMode(button.dataset.realExecutionMode));
});
$("setting-risk-per-trade").addEventListener("input", updateSettingFromInput);
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
$("setting-max-leverage").addEventListener("input", updateSettingFromInput);
$("setting-max-margin-usage").addEventListener("input", updateSettingFromInput);
$("setting-max-total-margin-usage").addEventListener("input", updateSettingFromInput);
$("setting-max-open-positions").addEventListener("input", updateSettingFromInput);
$("setting-max-position-per-symbol").addEventListener("input", updateSettingFromInput);
$("setting-minimum-rr").addEventListener("input", updateSettingFromInput);
$("setting-daily-profit-limit-r").addEventListener("input", updateSettingFromInput);
$("setting-daily-loss-limit-r").addEventListener("input", updateSettingFromInput);
$("setting-max-drawdown").addEventListener("input", updateSettingFromInput);
$("setting-ema-period").addEventListener("input", updateSettingFromInput);
$("setting-swing-left").addEventListener("input", updateSettingFromInput);
$("setting-swing-right").addEventListener("input", updateSettingFromInput);
$("setting-sl-buffer-ticks").addEventListener("input", updateSettingFromInput);
$("setting-sl-buffer-percent").addEventListener("input", updateSettingFromInput);
$("setting-sl-atr-period").addEventListener("input", updateSettingFromInput);
$("setting-sl-atr-multiplier").addEventListener("input", updateSettingFromInput);
$("setting-displacement-body").addEventListener("input", updateSettingFromInput);
$("setting-displacement-lookback").addEventListener("input", updateSettingFromInput);
$("setting-ai-min-confidence").addEventListener("input", updateSettingFromInput);
$("setting-ai-model").addEventListener("input", (event) => {
  settingsState.aiModel = event.target.value;
  setStatus("settings-status", "Unsaved changes");
});
document.querySelectorAll("[data-setting-group]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[data-setting-value]");
    if (!button) return;
    settingsState[group.dataset.settingGroup] = button.dataset.settingValue;
    renderSettings();
    saveSettings();
  });
});
$("config-mode-control").addEventListener("click", (event) => {
  const button = event.target.closest("[data-config-mode]");
  if (!button) return;
  changeConfigMode(button.dataset.configMode);
});
$("risk-level-selector").addEventListener("click", (event) => {
  const button = event.target.closest("[data-risk-level]");
  if (!button || button.dataset.riskLevel === settingsState.riskLevel) return;
  settingsState.riskLevel = button.dataset.riskLevel;
  applyPresetToDraft();
  renderSettings();
  saveSettings();
});
document.querySelectorAll("[data-settings-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.settingsMode;
    $("settings-view").dataset.settingsMode = mode;
    document.querySelectorAll("[data-settings-mode]").forEach((item) => item.classList.toggle("active", item === button));
  });
});
function showView(view) {
  $("boot-loader").hidden = true;
  activeView = view;
  if (MAIN_VIEWS.has(view)) localStorage.setItem(LAST_MAIN_VIEW_STORAGE_KEY, view);
  $("home-view").classList.toggle("active", view === "home");
  $("chart-view").classList.toggle("active", view === "chart");
  $("analysis-view").classList.toggle("active", view === "analysis");
  $("settings-view").classList.toggle("active", view === "settings");
  $("account-view").classList.toggle("active", view === "account");
  $("account-manage-view").classList.toggle("active", view === "account-manage");
  $("onboarding-view").classList.toggle("active", view === "onboarding");
  $("account-create-view").classList.toggle("active", view === "account-create");
  $("connect-view").classList.toggle("active", view === "connect");
  $("home-nav").classList.toggle("active", view === "home");
  $("chart-nav").classList.toggle("active", view === "chart");
  $("analysis-nav").classList.toggle("active", view === "analysis");
  $("settings-nav").classList.toggle("active", view === "settings");

  if (view === "home") {
    startHomePolling();
  } else {
    stopHomePolling();
  }

  if (view === "chart") {
    startChartPolling();
    requestAnimationFrame(resizeChart);
  } else {
    stopChartPolling();
  }

  if (view === "analysis") {
    loadAnalysis();
  }

  if (view === "settings") {
    loadSettings();
  }
}

function getStoredMainView() {
  const stored = localStorage.getItem(LAST_MAIN_VIEW_STORAGE_KEY);
  return MAIN_VIEWS.has(stored) ? stored : "home";
}

function accountStorageKey(name, accountId = accountState.activeAccount?.id) {
  return accountId ? `smc-futures-bot:${accountId}:${name}` : `smc-futures-bot:${name}`;
}

function restoreWorkspaceInputs(accountId) {
  const symbol =
    localStorage.getItem(accountStorageKey("workspace-symbol", accountId)) ??
    localStorage.getItem(accountStorageKey("chart-symbol", accountId)) ??
    localStorage.getItem(accountStorageKey("analysis-symbol", accountId)) ??
    DEFAULT_SYMBOL;
  $("chart-symbol").value = symbol;
  $("chart-interval").value = localStorage.getItem(accountStorageKey("chart-interval", accountId)) ?? "5m";
  $("analysis-symbol").value = symbol;
}

function rememberWorkspaceSymbol(symbol) {
  localStorage.setItem(accountStorageKey("workspace-symbol"), symbol);
  localStorage.setItem(accountStorageKey("chart-symbol"), symbol);
  localStorage.setItem(accountStorageKey("analysis-symbol"), symbol);
  $("chart-symbol").value = symbol;
  $("analysis-symbol").value = symbol;
}

function rememberChartInputs(symbol, interval) {
  rememberWorkspaceSymbol(symbol);
  localStorage.setItem(accountStorageKey("chart-interval"), interval);
}

function rememberAnalysisSymbol(symbol) {
  rememberWorkspaceSymbol(symbol);
}

// lightweight-charts is only needed on the Chart tab, so it loads on demand instead of blocking first paint.
function loadChartLibrary() {
  if (window.LightweightCharts) return Promise.resolve();
  chartState.library ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHART_LIBRARY_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Forget the failed attempt so the next Chart visit retries.
      chartState.library = null;
      script.remove();
      reject(new Error("Could not load the chart library"));
    };
    document.head.append(script);
  });
  return chartState.library;
}

function whenIdle(callback) {
  if ("requestIdleCallback" in window) window.requestIdleCallback(callback, { timeout: 5000 });
  else setTimeout(callback, 2000);
}

async function ensureChart() {
  if (chartState.instance) return;
  // Same ?v= as index.html so a cached chart module never pairs with a newer app.js.
  chartState.module ??= import("./chart/Chart.js?v=20261026-3");
  const [{ TradingChart }] = await Promise.all([chartState.module, loadChartLibrary()]);
  if (chartState.instance) return;

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
    hideOtherSymbolsInput: $("hide-other-symbols"),
  });
}

async function loadChart() {
  try {
    await ensureChart();
    if (activeView !== "chart") return;
    const accountId = accountState.activeAccount?.id;
    if (!accountId) {
      setStatus("chart-status", "Select a trading account");
      return;
    }
    const symbol = $("chart-symbol").value.trim().toUpperCase() || DEFAULT_SYMBOL;
    const interval = $("chart-interval").value;
    $("chart-symbol").value = symbol;
    rememberChartInputs(symbol, interval);
    await chartState.instance.load({ accountId, symbol, interval, limit: 300 });
    // load() wrote its own summary; drop any error colour left by a failed poll.
    if (activeView === "chart") $("chart-status").dataset.tone = "";
  } catch (error) {
    if (activeView !== "chart") return;
    setStatus("chart-status", error instanceof Error ? error.message : String(error));
  }
}

function resizeChart() {
  chartState.instance?.resize();
}

function currentAnalysisSymbol() {
  return $("analysis-symbol").value.trim().toUpperCase() || DEFAULT_SYMBOL;
}

// quiet: a live refresh after the symbol was scanned, so no "Analyzing" flash or disabled button.
async function loadAnalysis({ quiet = false } = {}) {
  const accountId = accountState.activeAccount?.id;
  const sequence = ++analysisRequestSequence;
  const symbol = currentAnalysisSymbol();
  $("analysis-symbol").value = symbol;
  rememberAnalysisSymbol(symbol);
  if (!accountId) {
    setStatus("analysis-status", "Select a trading account");
    return;
  }
  if (!quiet) {
    setStatus("analysis-status", `Analyzing ${symbol}`);
    $("analysis-run").disabled = true;
  }

  try {
    const path = `/api/trading-accounts/${accountId}/analysis?symbol=${encodeURIComponent(symbol)}`;
    const response = await apiFetch(path);
    if (sequence !== analysisRequestSequence || accountId !== accountState.activeAccount?.id) return;
    if (handleUnauthorized(response)) return;
    if (!response.ok) throw await responseError(response, "Analysis request");
    renderAnalysis(await response.json());
  } catch (error) {
    if (sequence !== analysisRequestSequence || accountId !== accountState.activeAccount?.id) return;
    setStatus("analysis-status", error instanceof Error ? error.message : String(error));
  } finally {
    if (sequence === analysisRequestSequence) $("analysis-run").disabled = false;
  }
}

function renderAnalysis(analysis) {
  const conditions = analysis.conditions ?? [];
  const sourceLabel = analysis.analysisSource === "runtime" ? "Runtime setup" : analysis.analysisSource === "active-position" ? "Active position" : "Diagnostic fallback";
  setStatus("analysis-status", `${analysis.symbol ?? "-"} · ${sourceLabel} · ${conditions.length} conditions checked`);
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
  const riskChecks = [...(risk.checks ?? [])];
  if (risk.decision) {
    riskChecks.push({
      label: "Position Sizing",
      status: risk.decision.accepted ? "PASSED" : "INVALIDATED",
      detail: formatRiskDecisionDetail(risk.decision)
    });
  }
  let protectionBlocked = false;
  if (analysis.dailyRisk) {
    const dailyRisk = analysis.dailyRisk;
    protectionBlocked = protectionBlocked || !dailyRisk.newEntriesAllowed;
    riskChecks.push({
      label: "Daily Realized PnL",
      status: "PASSED",
      detail: `${formatSignedNumber(dailyRisk.realizedR)}R (${formatSignedUsdt(dailyRisk.realizedPnlUsdt)}) · Limits -${dailyRisk.dailyLossLimitR}R / +${dailyRisk.dailyProfitLimitR}R`
    });
    riskChecks.push({
      label: "Daily Entry Gate",
      status: dailyRisk.newEntriesAllowed ? "PASSED" : "INVALIDATED",
      detail: `${dailyEntryStatusLabel(dailyRisk)} · Reason ${dailyRisk.blockReason ?? "-"}`
    });
  }
  if (analysis.accountProtection) {
    const accountProtection = analysis.accountProtection;
    protectionBlocked = protectionBlocked || !accountProtection.newEntriesAllowed;
    riskChecks.push({
      label: "Account Gate",
      status: accountProtection.newEntriesAllowed ? "PASSED" : "INVALIDATED",
      detail: `${accountProtectionStatusLabel(accountProtection)} · Drawdown ${formatSignedNumber(accountProtection.drawdownPercent)}% / ${accountProtection.maxDrawdownPercent}%`
    });
  }
  $("analysis-risk-final").textContent = protectionBlocked ? "BLOCKED" : risk.final ?? "WAITING";
  $("analysis-risk-checks").replaceChildren(
    ...riskChecks.map((check) => analysisConditionItem(check, null)),
  );
}

function formatRiskDecisionDetail(decision) {
  const rejection = decision.accepted ? "" : ` · RISK REJECTED ${decision.rejectCode ?? decision.reason ?? ""}`;
  const symbolSuffix = decision.symbol ? ` ${String(decision.symbol).replace(/USDT$/, "")}` : "";
  const crossBlockedReason =
    decision.rejectCode === "CROSS_MARGIN_LIQUIDATION_SAFETY_UNSUPPORTED"
      ? " · Reason Cross-margin liquidation safety is not supported for automated execution because account-wide cross collateral exposure is not fully modeled"
      : "";
  const safetyBufferPrice = Number(decision.entry) * (Number(decision.liquidationSafetyBufferPercent) / 100);
  return [
    `Target Risk ${formatUsdt(decision.riskPerTradeUsdt ?? decision.targetRiskUsdt)}`,
    `Actual Risk ${formatUsdt(decision.actualRiskUsdt ?? decision.estimatedLoss)}`,
    `Entry ${formatPrice(decision.entry)}`,
    `Stop Loss ${formatPrice(decision.stopLoss)}`,
    `Take Profit ${formatPrice(decision.takeProfit)}`,
    `Quantity ${formatQuantity(decision.quantity)}${symbolSuffix}`,
    `Notional ${formatUsdt(decision.notional)}`,
    `Selected Leverage ${formatLeverageValue(decision.selectedLeverage ?? decision.leverage)}`,
    `Effective Max Leverage ${formatLeverageValue(decision.effectiveMaxLeverage ?? decision.maxLeverage)}`,
    `Required Margin ${formatUsdt(decision.requiredMargin ?? decision.margin)}`,
    `Max Allowed Margin ${formatUsdt(decision.maxAllowedMargin)}`,
    `Margin Usage ${formatRatio(decision.marginUsagePercent)}% / ${formatRatio(decision.maxMarginUsagePercent)}%`,
    `Portfolio Margin ${formatUsdt(decision.currentUsedMargin)} + ${formatUsdt(decision.candidateRequiredMargin)} = ${formatUsdt(decision.projectedTotalMargin)}`,
    `Total Margin Usage ${formatRatio(decision.totalMarginUsagePercent)}% / ${formatRatio(decision.maxTotalMarginUsagePercent)}%`,
    `Maintenance Margin ${formatUsdt(decision.maintenanceMarginAmount)}`,
    `Maintenance Bracket ${formatMaintenanceBracket(decision.maintenanceMarginBracket)}`,
    `Maintenance Margin Ratio ${formatRatio((decision.maintenanceMarginRate ?? 0) * 100)}%`,
    `Liquidation Boundary ${formatPrice(decision.estimatedLiquidationPrice)}`,
    `SL-Liquidation Distance ${formatPrice(decision.distanceSlToLiquidation)}`,
    `Safety Buffer ${formatPrice(safetyBufferPrice)} (${formatRatio(decision.liquidationSafetyBufferPercent)}%)`,
    `Margin Mode ${decision.marginMode ?? "-"}`,
    `Liquidation Safety ${decision.liquidationSafetyStatus ?? "LIQUIDATION_SAFETY_UNVERIFIED"}${rejection}${crossBlockedReason}`
  ].join(" · ");
}

function formatMaintenanceBracket(bracket) {
  if (!bracket) return "-";
  return bracket.bracket ?? `${formatPrice(bracket.notionalFloor)}-${formatPrice(bracket.notionalCap)}`;
}

function formatLeverageValue(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${Math.ceil(Number(value))}x`;
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

async function loadSettings(accountId = accountState.activeAccount?.id ?? null) {
  if (!accountId) return;
  const sequence = ++settingsRequestSequence;
  const settingsPath = `/api/trading-accounts/${accountId}/settings`;
  const watchlistPath = `/api/trading-accounts/${accountId}/watchlist`;
  const symbolsPath = `/api/market/symbols?accountId=${encodeURIComponent(accountId)}`;
  setStatus("settings-status", "Loading");
  const needsSymbols = marketSymbolsAccountId !== accountId || marketSymbols.length === 0;
  try {
    const [response, symbolsResponse, watchlistResponse] = await Promise.all([
      apiFetch(settingsPath),
      needsSymbols ? apiFetch(symbolsPath) : null,
      apiFetch(watchlistPath),
      loadTradingPresets(),
    ]);
    if (sequence !== settingsRequestSequence || accountId !== (accountState.activeAccount?.id ?? null)) return;
    if (handleUnauthorized(response) || (symbolsResponse && handleUnauthorized(symbolsResponse)) || handleUnauthorized(watchlistResponse)) return;
    if (!response.ok) throw new Error(`Settings request failed: ${response.status}`);
    if (symbolsResponse && !symbolsResponse.ok) throw new Error(`Symbols request failed: ${symbolsResponse.status}`);
    if (!watchlistResponse.ok) throw new Error(`Watchlist request failed: ${watchlistResponse.status}`);
    if (symbolsResponse) {
      marketSymbols = await symbolsResponse.json();
      marketSymbolsAccountId = accountId;
    }
    if (sequence !== settingsRequestSequence || accountId !== (accountState.activeAccount?.id ?? null)) return;
    Object.assign(settingsState, defaultSettings, settingsFromApi(await response.json()));
    const watchlist = await watchlistResponse.json();
    if (Array.isArray(watchlist.watchlist)) {
      settingsState.watchlist = watchlist.watchlist.join(",");
    }
    if (accountState.activeAccount?.mode === "REAL") {
      await Promise.all([loadRealExecutionMode(accountId, sequence), loadRealProposals(accountId, sequence)]);
    } else {
      Object.assign(realSafetyState, { mode: "LOCKED", masterLiveExecutionEnabled: false, proposals: [] });
    }
    setStatus("settings-status", "Loaded");
  } catch {
    if (sequence !== settingsRequestSequence || accountId !== (accountState.activeAccount?.id ?? null)) return;
    Object.assign(settingsState, defaultSettings);
    marketSymbols = [];
    marketSymbolsAccountId = null;
    setStatus("settings-status", "Load failed");
  }
  renderSettings();
}

function renderSettings() {
  renderWatchlistSettings();
  renderRealSafety();
  $("setting-risk-per-trade").value = settingsState.riskPerTradeUsdt;
  $("setting-max-leverage").value = settingsState.maxLeverage;
  $("setting-max-margin-usage").value = settingsState.maxMarginUsagePercent;
  $("setting-max-total-margin-usage").value = settingsState.maxTotalMarginUsagePercent;
  $("setting-max-open-positions").value = settingsState.maxOpenPositions;
  $("setting-max-position-per-symbol").value = settingsState.maxPositionPerSymbol;
  $("setting-minimum-rr").value = settingsState.minimumRiskReward;
  $("setting-daily-profit-limit-r").value = settingsState.dailyProfitLimitR;
  $("setting-daily-loss-limit-r").value = settingsState.dailyLossLimitR;
  $("setting-max-drawdown").value = settingsState.maxDrawdownPercent;
  $("setting-ema-period").value = settingsState.emaPeriod;
  $("setting-swing-left").value = settingsState.swingLeft;
  $("setting-swing-right").value = settingsState.swingRight;
  $("setting-sl-buffer-ticks").value = settingsState.stopLossBufferTicks;
  $("setting-sl-buffer-percent").value = settingsState.stopLossBufferPercent;
  $("setting-sl-atr-period").value = settingsState.stopLossAtrPeriod;
  $("setting-sl-atr-multiplier").value = settingsState.stopLossAtrMultiplier;
  $("setting-displacement-body").value = settingsState.displacementBodyMultiplier;
  $("setting-displacement-lookback").value = settingsState.displacementLookback;
  $("setting-ai-model").value = settingsState.aiModel;
  $("setting-ai-min-confidence").value = settingsState.aiMinConfidence;
  updateConditionalSettingVisibility();
  renderRiskSummary();
  renderConfigMode();

  document.querySelectorAll("[data-setting-group]").forEach((group) => {
    const value = settingsState[group.dataset.settingGroup];
    group.querySelectorAll("[data-setting-value]").forEach((button) => {
      button.classList.toggle("active", button.dataset.settingValue === value);
    });
  });
}

function renderRiskSummary() {
  $("summary-risk").textContent = formatUsdt(settingsState.riskPerTradeUsdt);
  $("summary-daily-loss").textContent = `-${formatUsdt(Number(settingsState.riskPerTradeUsdt) * Number(settingsState.dailyLossLimitR))}`;
  $("summary-daily-profit").textContent = `+${formatUsdt(Number(settingsState.riskPerTradeUsdt) * Number(settingsState.dailyProfitLimitR))}`;
  $("summary-rr").textContent = settingsState.minimumRiskReward;
  $("summary-positions").textContent = settingsState.maxOpenPositions;
  $("summary-margin-mode").textContent = settingsState.marginMode;
  $("settings-risk-summary-note").textContent = "Tighter SL creates a larger position; wider SL creates a smaller position. Approximate loss at SL remains 1R.";
}

async function loadTradingPresets() {
  if (tradingPresets.length > 0) return;
  try {
    const response = await apiFetch("/api/trading-presets");
    if (!response.ok) return;
    const body = await response.json();
    tradingPresets = Array.isArray(body.presets) ? body.presets : [];
  } catch {
    tradingPresets = [];
  }
}

function activePreset() {
  return tradingPresets.find((preset) => String(preset.level) === settingsState.riskLevel) ?? null;
}

// Copies the selected preset into the draft so the advanced form starts from the preset values.
function applyPresetToDraft() {
  const preset = activePreset();
  if (!preset) return;
  for (const [field, value] of Object.entries(preset.values)) {
    settingsState[field] = String(value);
  }
}

function changeConfigMode(mode) {
  if (mode === settingsState.settingsMode) return;
  if (mode === "simple") {
    const confirmed = window.confirm("Simple mode replaces strategy and risk settings with the preset of the selected risk level. Continue?");
    if (!confirmed) return;
  } else {
    applyPresetToDraft();
  }
  settingsState.settingsMode = mode;
  renderSettings();
  saveSettings();
}

function renderConfigMode() {
  const mode = settingsState.settingsMode === "simple" ? "simple" : "advanced";
  const view = $("settings-view");
  view.dataset.configMode = mode;
  if (mode === "simple" && view.dataset.settingsMode !== "basic") {
    // Simple mode shows the basic cards (watchlist, 1R, bot control) only.
    view.dataset.settingsMode = "basic";
    document.querySelectorAll(".settings-mode-tab").forEach((item) => item.classList.toggle("active", item.dataset.settingsMode === "basic"));
  }
  $("config-mode-control").querySelectorAll("[data-config-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.configMode === mode);
  });
  $("config-mode-note").textContent = mode === "simple"
    ? "Simple: choose a risk level, the bot applies a tested preset."
    : "Advanced: every strategy and risk parameter is editable.";
  renderRiskLevelSelector();
}

function renderRiskLevelSelector() {
  if (tradingPresets.length === 0) {
    $("risk-level-selector").innerHTML = `<span class="empty-selection">Presets unavailable</span>`;
    $("risk-level-description").textContent = "";
    return;
  }
  $("risk-level-selector").replaceChildren(
    ...tradingPresets.map((preset) => {
      const button = document.createElement("button");
      const active = String(preset.level) === settingsState.riskLevel;
      button.type = "button";
      button.className = `risk-level-option${active ? " active" : ""}`;
      button.dataset.riskLevel = String(preset.level);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(active));
      button.innerHTML = `<strong>${escapeHtml(String(preset.level))}</strong><small>${escapeHtml(preset.label)}</small>`;
      return button;
    })
  );
  const preset = activePreset();
  const values = preset?.values;
  $("risk-level-description").textContent = preset?.description ?? "";
  $("preset-summary-rr").textContent = values ? `1:${values.minimumRiskReward}` : "-";
  $("preset-summary-leverage").textContent = values ? `${values.maxLeverage}x` : "-";
  $("preset-summary-margin").textContent = values ? `${values.maxMarginUsagePercent}%` : "-";
  $("preset-summary-positions").textContent = values ? String(values.maxOpenPositions) : "-";
  $("preset-summary-daily-loss").textContent = values ? `${values.dailyLossLimitR}R` : "-";
  $("preset-summary-entry").textContent = values ? (values.entryMode === "limit" ? "Limit" : "Market") : "-";
}

function renderRealSafety() {
  const isReal = accountState.activeAccount?.mode === "REAL";
  $("real-execution-safety").hidden = !isReal;
  $("real-proposals-section").hidden = !isReal;
  if (!isReal) return;

  const mode = realSafetyState.mode ?? settingsState.realExecutionMode ?? "LOCKED";
  settingsState.realExecutionMode = mode;
  $("real-master-lock").textContent = realSafetyState.masterLiveExecutionEnabled ? "UNLOCKED" : "LOCKED BY SERVER";
  $("real-execution-mode-detail").textContent = realExecutionModeDescription(mode);
  document.querySelectorAll("[data-real-execution-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.realExecutionMode === mode);
  });
  renderRealProposals();
}

function updateConditionalSettingVisibility() {
  const displacementOn = settingsState.requireDisplacement === "true";
  $("setting-displacement-body-card").hidden = !displacementOn;
  $("setting-displacement-lookback-card").hidden = !displacementOn;

  const bufferMode = settingsState.stopLossBufferMode;
  $("setting-sl-buffer-ticks-card").hidden = bufferMode !== "ticks";
  $("setting-sl-buffer-percent-card").hidden = bufferMode !== "percentage";
  $("setting-sl-atr-period-card").hidden = bufferMode !== "atr";
  $("setting-sl-atr-multiplier-card").hidden = bufferMode !== "atr";
}

function realExecutionModeDescription(mode) {
  if (mode === "DRY_RUN") return "Bot may create simulated proposals. No Binance order is sent.";
  if (mode === "APPROVAL_REQUIRED") return "Bot may create PENDING proposals. Approval still does not send a Binance order.";
  return "Bot cannot create REAL execution proposals or send orders.";
}

async function loadRealExecutionMode(accountId = accountState.activeAccount?.id ?? null, sequence = settingsRequestSequence) {
  if (!accountId || accountState.activeAccount?.mode !== "REAL") return;
  const response = await apiFetch(`/api/trading-accounts/${accountId}/real-execution-mode`);
  if (sequence !== settingsRequestSequence || accountId !== accountState.activeAccount?.id) return;
  if (handleUnauthorized(response)) return;
  if (!response.ok) throw new Error(`REAL execution mode request failed: ${response.status}`);
  const body = await response.json();
  realSafetyState.mode = body.mode ?? "LOCKED";
  realSafetyState.masterLiveExecutionEnabled = Boolean(body.masterLiveExecutionEnabled);
  settingsState.realExecutionMode = realSafetyState.mode;
}

async function changeRealExecutionMode(mode) {
  const account = accountState.activeAccount;
  if (!account || account.mode !== "REAL") return;
  if (mode !== "LOCKED") {
    const confirmed = window.confirm(
      `You are enabling REAL proposal generation for ${account.name}.\n\nEnvironment: Mainnet\nSelected mode: ${mode}\nLive execution remains server-locked.\n\nNo Binance Mainnet orders will be submitted.`
    );
    if (!confirmed) return;
  }
  setStatus("settings-status", "Saving REAL execution mode");
  const response = await apiFetch(`/api/trading-accounts/${account.id}/real-execution-mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (handleUnauthorized(response)) return;
  if (!response.ok) {
    setStatus("settings-status", `Mode save failed: ${response.status}`);
    return;
  }
  const body = await response.json();
  realSafetyState.mode = body.mode ?? "LOCKED";
  realSafetyState.masterLiveExecutionEnabled = Boolean(body.masterLiveExecutionEnabled);
  settingsState.realExecutionMode = realSafetyState.mode;
  renderRealSafety();
  await loadRealProposals(account.id);
  setStatus("settings-status", "REAL execution mode saved");
}

async function loadRealProposals(accountId = accountState.activeAccount?.id ?? null, sequence = settingsRequestSequence) {
  if (!accountId || accountState.activeAccount?.mode !== "REAL") return;
  const status = $("real-proposal-status-filter").value;
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await apiFetch(`/api/trading-accounts/${accountId}/real-execution-proposals${suffix}`);
  if (sequence !== settingsRequestSequence || accountId !== accountState.activeAccount?.id) return;
  if (handleUnauthorized(response)) return;
  if (!response.ok) throw new Error(`REAL proposals request failed: ${response.status}`);
  realSafetyState.proposals = (await response.json()).proposals ?? [];
  renderRealProposals();
}

function renderRealProposals() {
  if (accountState.activeAccount?.mode !== "REAL") return;
  const proposals = realSafetyState.proposals ?? [];
  if (proposals.length === 0) {
    $("real-proposals-body").innerHTML = `<tr><td colspan="11" class="empty-position">No proposals</td></tr>`;
    $("real-proposal-detail").hidden = true;
    return;
  }
  $("real-proposals-body").replaceChildren(
    ...proposals.map((proposal) => {
      const row = document.createElement("tr");
      const rr = proposal.normalizedEntryPrice && proposal.normalizedStopLoss
        ? Math.abs((proposal.normalizedTakeProfit - proposal.normalizedEntryPrice) / (proposal.normalizedEntryPrice - proposal.normalizedStopLoss))
        : null;
      row.innerHTML = `
        <td>${escapeHtml(formatDateTime(proposal.createdAt))}</td>
        <td>${escapeHtml(proposal.symbol)}</td>
        <td>${escapeHtml(proposal.direction)}</td>
        <td>${proposal.normalizedEntryPrice === null ? "MARKET" : escapeHtml(formatPrice(proposal.normalizedEntryPrice))}</td>
        <td>${escapeHtml(formatQuantity(proposal.normalizedQuantity))}</td>
        <td>${escapeHtml(formatPrice(proposal.normalizedStopLoss))}</td>
        <td>${escapeHtml(formatPrice(proposal.normalizedTakeProfit))}</td>
        <td>${rr === null || !Number.isFinite(rr) ? "-" : escapeHtml(rr.toFixed(2))}</td>
        <td><span class="status-badge">${escapeHtml(proposal.status)}</span></td>
        <td>${escapeHtml(String(proposal.setupKey).slice(0, 24))}</td>
      `;
      const actions = document.createElement("td");
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.textContent = "Inspect";
      inspect.addEventListener("click", () => showProposalDetail(proposal));
      actions.appendChild(inspect);
      if (proposal.status === "PENDING") {
        const approve = document.createElement("button");
        approve.type = "button";
        approve.textContent = "Approve";
        approve.addEventListener("click", () => transitionProposal(proposal.id, "approve"));
        const reject = document.createElement("button");
        reject.type = "button";
        reject.textContent = "Reject";
        reject.addEventListener("click", () => transitionProposal(proposal.id, "reject"));
        actions.append(approve, reject);
      }
      row.appendChild(actions);
      return row;
    })
  );
}

function showProposalDetail(proposal) {
  $("real-proposal-detail").hidden = false;
  $("real-proposal-detail").textContent = JSON.stringify({
    id: proposal.id,
    symbol: proposal.symbol,
    side: proposal.direction,
    orderType: proposal.requestedEntryType,
    entry: proposal.normalizedEntryPrice ?? "MARKET",
    quantity: proposal.normalizedQuantity,
    stopLoss: proposal.normalizedStopLoss,
    takeProfit: proposal.normalizedTakeProfit,
    notional: proposal.estimatedNotional,
    margin: proposal.estimatedMargin,
    leverage: proposal.configuredLeverage,
    status: proposal.status,
    setupKey: proposal.setupKey,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    note: "Approval records operator approval only. Live order submission remains disabled."
  }, null, 2);
}

async function transitionProposal(proposalId, action) {
  const account = accountState.activeAccount;
  if (!account || account.mode !== "REAL") return;
  const message = action === "approve"
    ? "Approval records operator approval only. Live order submission remains disabled."
    : "Reject this proposal?";
  if (!window.confirm(message)) return;
  const response = await apiFetch(`/api/trading-accounts/${account.id}/real-execution-proposals/${proposalId}/${action}`, { method: "POST" });
  if (handleUnauthorized(response)) return;
  setStatus("settings-status", response.ok ? "Proposal updated" : `Proposal update failed: ${response.status}`);
  await loadRealProposals(account.id);
}

function updateSettingFromInput(event) {
  const field = settingFieldByInputId[event.target.id];
  if (!field) return;
  const rule = numericSettingRules[field];
  const value = sanitizeNumericDraft(event.target.value, rule);
  if (event.target.value !== value) {
    event.target.value = value;
  }
  settingsState[field] = value;
  event.target.classList.toggle("invalid", value === "");
  setStatus("settings-status", value === "" ? `${rule.label} is required` : "Unsaved changes");
}

async function saveSettings() {
  const accountId = accountState.activeAccount?.id ?? null;
  if (!accountId) {
    setStatus("settings-status", "Select a trading account");
    return;
  }
  const validation = settingsState.settingsMode === "simple" ? validateSimpleSettingsDraft() : validateSettingsDraft();
  if (!validation.ok) {
    setStatus("settings-status", validation.message);
    validation.element?.focus();
    return;
  }
  const settingsPath = `/api/trading-accounts/${accountId}/settings`;
  setStatus("settings-status", "Saving");
  const payload = settingsState.settingsMode === "simple" ? simpleSettingsPayload() : settingsPayload();
  const response = await apiFetch(settingsPath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (accountId !== (accountState.activeAccount?.id ?? null)) return;
  if (handleUnauthorized(response)) return;
  if (!response.ok) {
    setStatus("settings-status", `Save failed: ${response.status}`);
    return;
  }
  Object.assign(settingsState, settingsFromApi(await response.json()));
  renderSettings();
  setStatus("settings-status", "Saved");
}

function resetSettings() {
  Object.assign(settingsState, defaultSettings, { settingsMode: settingsState.settingsMode });
  renderSettings();
  saveSettings();
}

function settingsFromApi(settings) {
  return {
    ...settings,
    watchlist: Array.isArray(settings.watchlist) ? settings.watchlist.join(",") : String(settings.watchlist ?? defaultSettings.watchlist),
    settingsMode: settings.settingsMode === "simple" ? "simple" : "advanced",
    riskLevel: String(settings.riskLevel ?? defaultSettings.riskLevel),
    positionSizingMode: String(settings.positionSizingMode ?? defaultSettings.positionSizingMode),
    riskPerTradeUsdt: String(settings.riskPerTradeUsdt ?? defaultSettings.riskPerTradeUsdt),
    maxLeverage: String(settings.maxLeverage ?? defaultSettings.maxLeverage),
    maxMarginUsagePercent: String(settings.maxMarginUsagePercent ?? defaultSettings.maxMarginUsagePercent),
    maxTotalMarginUsagePercent: String(settings.maxTotalMarginUsagePercent ?? defaultSettings.maxTotalMarginUsagePercent),
    liquidationSafetyBufferPercent: String(settings.liquidationSafetyBufferPercent ?? defaultSettings.liquidationSafetyBufferPercent),
    marginMode: String(settings.marginMode ?? defaultSettings.marginMode),
    entryMode: String(settings.entryMode ?? defaultSettings.entryMode),
    maxOpenPositions: String(settings.maxOpenPositions ?? defaultSettings.maxOpenPositions),
    maxPositionPerSymbol: String(settings.maxPositionPerSymbol ?? defaultSettings.maxPositionPerSymbol),
    minimumRiskReward: String(settings.minimumRiskReward ?? defaultSettings.minimumRiskReward),
    dailyProfitLimitR: String(settings.dailyProfitLimitR ?? defaultSettings.dailyProfitLimitR),
    dailyLossLimitR: String(settings.dailyLossLimitR ?? defaultSettings.dailyLossLimitR),
    maxDrawdownPercent: String(settings.maxDrawdownPercent ?? defaultSettings.maxDrawdownPercent),
    tradingEnabled: String(settings.tradingEnabled ?? "false"),
    killSwitch: String(settings.killSwitch ?? "false"),
    realExecutionMode: String(settings.realExecutionMode ?? defaultSettings.realExecutionMode),
    emaPeriod: String(settings.emaPeriod ?? defaultSettings.emaPeriod),
    swingLeft: String(settings.swingLeft ?? defaultSettings.swingLeft),
    swingRight: String(settings.swingRight ?? defaultSettings.swingRight),
    stopLossBufferMode: String(settings.stopLossBufferMode ?? defaultSettings.stopLossBufferMode),
    stopLossBufferTicks: String(settings.stopLossBufferTicks ?? defaultSettings.stopLossBufferTicks),
    stopLossBufferPercent: String(settings.stopLossBufferPercent ?? defaultSettings.stopLossBufferPercent),
    stopLossAtrPeriod: String(settings.stopLossAtrPeriod ?? defaultSettings.stopLossAtrPeriod),
    stopLossAtrMultiplier: String(settings.stopLossAtrMultiplier ?? defaultSettings.stopLossAtrMultiplier),
    requireDisplacement: String(settings.requireDisplacement ?? "false"),
    displacementBodyMultiplier: String(settings.displacementBodyMultiplier ?? defaultSettings.displacementBodyMultiplier),
    displacementLookback: String(settings.displacementLookback ?? defaultSettings.displacementLookback),
    aiTradingMode: ["OFF", "ADVISORY", "AUTO"].includes(settings.aiTradingMode) ? settings.aiTradingMode : defaultSettings.aiTradingMode,
    aiModel: String(settings.aiModel ?? defaultSettings.aiModel),
    aiMinConfidence: String(settings.aiMinConfidence ?? defaultSettings.aiMinConfidence),
  };
}

function settingsPayload() {
  const watchlist = getSelectedWatchlist();
  return {
    settingsMode: "advanced",
    riskLevel: settingNumber("riskLevel"),
    watchlist,
    symbol: watchlist[0] ?? "BTCUSDT",
    positionSizingMode: settingsState.positionSizingMode,
    riskPerTradeUsdt: settingNumber("riskPerTradeUsdt"),
    maxLeverage: settingNumber("maxLeverage"),
    maxMarginUsagePercent: settingNumber("maxMarginUsagePercent"),
    maxTotalMarginUsagePercent: settingNumber("maxTotalMarginUsagePercent"),
    liquidationSafetyBufferPercent: settingNumber("liquidationSafetyBufferPercent"),
    marginMode: settingsState.marginMode,
    entryMode: settingsState.entryMode,
    maxOpenPositions: settingNumber("maxOpenPositions"),
    maxPositionPerSymbol: settingNumber("maxPositionPerSymbol"),
    minimumRiskReward: settingNumber("minimumRiskReward"),
    dailyProfitLimitR: settingNumber("dailyProfitLimitR"),
    dailyLossLimitR: settingNumber("dailyLossLimitR"),
    maxDrawdownPercent: settingNumber("maxDrawdownPercent"),
    tradingEnabled: settingsState.tradingEnabled === "true",
    killSwitch: settingsState.killSwitch === "true",
    realExecutionMode: settingsState.realExecutionMode,
    emaPeriod: settingNumber("emaPeriod"),
    swingLeft: settingNumber("swingLeft"),
    swingRight: settingNumber("swingRight"),
    stopLossBufferMode: settingsState.stopLossBufferMode,
    stopLossBufferTicks: settingNumber("stopLossBufferTicks"),
    stopLossBufferPercent: settingNumber("stopLossBufferPercent"),
    stopLossAtrPeriod: settingNumber("stopLossAtrPeriod"),
    stopLossAtrMultiplier: settingNumber("stopLossAtrMultiplier"),
    requireDisplacement: settingsState.requireDisplacement === "true",
    displacementBodyMultiplier: settingNumber("displacementBodyMultiplier"),
    displacementLookback: settingNumber("displacementLookback"),
    aiTradingMode: settingsState.aiTradingMode,
    aiModel: String(settingsState.aiModel ?? "").trim(),
    aiMinConfidence: settingNumber("aiMinConfidence"),
  };
}

// Simple mode only sends the user-specific fields; the server derives every preset field from riskLevel.
function simpleSettingsPayload() {
  return {
    settingsMode: "simple",
    riskLevel: settingNumber("riskLevel"),
    watchlist: getSelectedWatchlist(),
    riskPerTradeUsdt: settingNumber("riskPerTradeUsdt"),
    tradingEnabled: settingsState.tradingEnabled === "true",
    killSwitch: settingsState.killSwitch === "true",
    aiTradingMode: settingsState.aiTradingMode,
  };
}

function settingNumber(field) {
  return parseSettingNumber(settingsState[field]);
}

function parseSettingNumber(value) {
  return Number(String(value ?? "").trim().replace(",", "."));
}

const settingFieldByInputId = {
  "setting-risk-per-trade": "riskPerTradeUsdt",
  "setting-max-leverage": "maxLeverage",
  "setting-max-margin-usage": "maxMarginUsagePercent",
  "setting-max-total-margin-usage": "maxTotalMarginUsagePercent",
  "setting-liquidation-safety-buffer": "liquidationSafetyBufferPercent",
  "setting-max-open-positions": "maxOpenPositions",
  "setting-max-position-per-symbol": "maxPositionPerSymbol",
  "setting-minimum-rr": "minimumRiskReward",
  "setting-daily-profit-limit-r": "dailyProfitLimitR",
  "setting-daily-loss-limit-r": "dailyLossLimitR",
  "setting-max-drawdown": "maxDrawdownPercent",
  "setting-ema-period": "emaPeriod",
  "setting-swing-left": "swingLeft",
  "setting-swing-right": "swingRight",
  "setting-sl-buffer-ticks": "stopLossBufferTicks",
  "setting-sl-buffer-percent": "stopLossBufferPercent",
  "setting-sl-atr-period": "stopLossAtrPeriod",
  "setting-sl-atr-multiplier": "stopLossAtrMultiplier",
  "setting-displacement-body": "displacementBodyMultiplier",
  "setting-displacement-lookback": "displacementLookback",
  "setting-ai-min-confidence": "aiMinConfidence",
};

const numericSettingRules = {
  riskPerTradeUsdt: { id: "setting-risk-per-trade", label: "Risk per Trade", min: 0, exclusiveMin: true },
  maxLeverage: { id: "setting-max-leverage", label: "Max Leverage", min: 1, max: 125, integer: true },
  maxMarginUsagePercent: { id: "setting-max-margin-usage", label: "Max Margin Usage", min: 0, exclusiveMin: true, max: 100 },
  maxTotalMarginUsagePercent: { id: "setting-max-total-margin-usage", label: "Max Total Margin Usage", min: 0, exclusiveMin: true, max: 100 },
  maxOpenPositions: { id: "setting-max-open-positions", label: "Max Open Positions", min: 1, integer: true },
  maxPositionPerSymbol: { id: "setting-max-position-per-symbol", label: "Max Position Per Symbol", min: 1, max: 1, integer: true },
  minimumRiskReward: { id: "setting-minimum-rr", label: "Minimum R/R", min: 0, exclusiveMin: true },
  dailyProfitLimitR: { id: "setting-daily-profit-limit-r", label: "Daily Profit Limit (R)", min: 0, exclusiveMin: true },
  dailyLossLimitR: { id: "setting-daily-loss-limit-r", label: "Daily Loss Limit (R)", min: 0, exclusiveMin: true },
  maxDrawdownPercent: { id: "setting-max-drawdown", label: "Max Drawdown", min: 0, exclusiveMin: true },
  emaPeriod: { id: "setting-ema-period", label: "EMA Period", min: 1, integer: true },
  swingLeft: { id: "setting-swing-left", label: "Swing Left", min: 1, integer: true },
  swingRight: { id: "setting-swing-right", label: "Swing Right", min: 1, integer: true },
  stopLossBufferTicks: { id: "setting-sl-buffer-ticks", label: "Buffer Ticks", min: 0 },
  stopLossBufferPercent: { id: "setting-sl-buffer-percent", label: "Buffer Percent", min: 0 },
  stopLossAtrPeriod: { id: "setting-sl-atr-period", label: "ATR Period", min: 1, integer: true },
  stopLossAtrMultiplier: { id: "setting-sl-atr-multiplier", label: "ATR Multiplier", min: 0 },
  displacementBodyMultiplier: { id: "setting-displacement-body", label: "Body Multiplier", min: 0, exclusiveMin: true },
  displacementLookback: { id: "setting-displacement-lookback", label: "Body Lookback", min: 1, integer: true },
  aiMinConfidence: { id: "setting-ai-min-confidence", label: "AI Min Confidence", min: 0, max: 1 },
};

function sanitizeNumericDraft(value, rule) {
  const source = String(value ?? "");
  if (rule.integer) return source.replace(/\D/g, "");

  let separatorSeen = false;
  let result = "";
  for (const char of source) {
    if (/\d/.test(char)) {
      result += char;
      continue;
    }
    if ((char === "." || char === ",") && !separatorSeen) {
      separatorSeen = true;
      result += char;
    }
  }
  return result;
}

function validateSettingsDraft() {
  clearSettingValidation();
  for (const [field, rule] of Object.entries(numericSettingRules)) {
    const element = $(rule.id);
    const rawValue = String(settingsState[field] ?? "").trim();
    const value = parseSettingNumber(rawValue);
    if (rawValue === "") {
      element.classList.add("invalid");
      return { ok: false, message: `${rule.label} is required`, element };
    }
    const invalidNumber = !Number.isFinite(value);
    const belowMin = rule.exclusiveMin ? value <= rule.min : value < rule.min;
    const aboveMax = rule.max !== undefined && value > rule.max;
    const invalidInteger = rule.integer && !Number.isInteger(value);
    if (invalidNumber || belowMin || aboveMax || invalidInteger) {
      element.classList.add("invalid");
      return { ok: false, message: validationMessage(rule), element };
    }
  }
  if (settingsState.tradingEnabled === "true" && getSelectedWatchlist().length === 0) {
    return { ok: false, message: "Watchlist cannot be empty when trading is enabled", element: $("setting-symbol-search") };
  }
  return { ok: true, message: "", element: null };
}

function validateSimpleSettingsDraft() {
  clearSettingValidation();
  const rule = numericSettingRules.riskPerTradeUsdt;
  const element = $(rule.id);
  const rawValue = String(settingsState.riskPerTradeUsdt ?? "").trim();
  const value = parseSettingNumber(rawValue);
  if (rawValue === "") {
    element.classList.add("invalid");
    return { ok: false, message: `${rule.label} is required`, element };
  }
  if (!Number.isFinite(value) || value <= rule.min) {
    element.classList.add("invalid");
    return { ok: false, message: validationMessage(rule), element };
  }
  if (settingsState.tradingEnabled === "true" && getSelectedWatchlist().length === 0) {
    return { ok: false, message: "Watchlist cannot be empty when trading is enabled", element: $("setting-symbol-search") };
  }
  return { ok: true, message: "", element: null };
}

function clearSettingValidation() {
  Object.values(numericSettingRules).forEach((rule) => $(rule.id).classList.remove("invalid"));
}

function validationMessage(rule) {
  if (rule.max !== undefined && rule.min === rule.max) return `${rule.label} must be ${rule.min}`;
  if (rule.integer) return `${rule.label} must be a whole number ${rule.min ?? 0} or higher`;
  if (rule.max !== undefined) return `${rule.label} must be between ${rule.exclusiveMin ? "above " : ""}${rule.min} and ${rule.max}`;
  return `${rule.label} must be ${rule.exclusiveMin ? "greater than" : "at least"} ${rule.min}`;
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
