import { apiFetch } from "./apiClient.js";

const $ = (id) => document.getElementById(id);
const HOME_POLL_INTERVAL_MS = 10_000;
const CHART_POLL_INTERVAL_MS = 10_000;
const LAST_MAIN_VIEW_STORAGE_KEY = "smc-futures-bot:last-main-view";
const MAIN_VIEWS = new Set(["home", "chart", "analysis", "settings"]);
const DEFAULT_SYMBOL = "BTCUSDT";
const chartState = {
  instance: null,
  timer: null,
  module: null,
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
const defaultSettings = {
  watchlist: "",
  positionSizingMode: "risk-based",
  riskPerTradeUsdt: "20",
  maxLeverage: "125",
  maxMarginUsagePercent: "20",
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
};
const settingsState = { ...defaultSettings };
const realSafetyState = {
  mode: "LOCKED",
  masterLiveExecutionEnabled: false,
  proposals: [],
};
let marketSymbols = [];
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
  $("login-message").textContent = "Please login to continue";
});

boot();

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
    $("register-message").textContent = "Passwords do not match";
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
  const message = $(`${form}-message`);
  submit.disabled = true;
  message.textContent = "Loading";

  try {
    const response = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(body.error ?? `Authentication failed: ${response.status}`);
    message.textContent = "";
    showLoggedIn(body.user);
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
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
  authState.user = null;
  stopHomePolling();
  stopChartPolling();
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
  $("login-message").textContent = "";
  $("register-message").textContent = "";
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
  $("login-message").textContent = "Please login to continue";
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

    await setActiveTradingAccount(accountState.accounts[0]);
    restoreWorkspaceInputs(accountState.accounts[0].id);
    showView(getStoredMainView());
    document.querySelector(".nav-tabs").hidden = false;
    $("account-selector").hidden = false;
    $("user-menu").hidden = false;
  } catch (error) {
    $("login-message").textContent = error instanceof Error ? error.message : String(error);
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
        await setActiveTradingAccount(item);
      });
      return button;
    }),
  );
}

async function setActiveTradingAccount(account) {
  accountState.activeAccount = account;
  chartState.instance?.cancelPendingLoad();
  Object.assign(settingsState, defaultSettings);
  Object.assign(realSafetyState, { mode: "LOCKED", masterLiveExecutionEnabled: false, proposals: [] });
  renderAccountSelector();
  renderSettings();
  restoreWorkspaceInputs(account.id);
  await Promise.all([loadActiveAccountStatus(), loadSettings(account.id)]);
  dashboardRequestSequence += 1;
  if ($("chart-view").classList.contains("active")) loadChart();
  if ($("analysis-view").classList.contains("active")) loadAnalysis();
  if ($("home-view").classList.contains("active")) load();
}

function startCreateAccount(mode) {
  accountState.pendingMode = mode === "REAL" ? "REAL" : "DEMO";
  $("account-create-title").textContent = accountState.pendingMode === "REAL" ? "Create Real Account" : "Create Demo Account";
  $("account-create-environment").textContent = accountEnvironmentLabel(accountState.pendingMode);
  $("account-create-name").value = accountState.pendingMode === "REAL" ? "My Binance" : "My Testnet";
  $("account-create-message").textContent = "";
  showView("account-create");
}

async function createTradingAccount() {
  const mode = accountState.pendingMode ?? "DEMO";
  $("account-create-submit").disabled = true;
  $("account-create-message").textContent = "Creating";
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
    $("account-create-message").textContent = error instanceof Error ? error.message : String(error);
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
  $("connect-message").textContent = "";
  accountState.testedCredentials = null;
  showView("connect");
}

async function testBinanceConnection() {
  const account = accountState.activeAccount;
  if (!account) return;
  const credentials = { apiKey: $("connect-api-key").value, apiSecret: $("connect-api-secret").value };
  $("connect-test-button").disabled = true;
  $("connect-message").textContent = "Testing connection";
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
    $("connect-message").textContent = "";
  } catch (error) {
    accountState.testedCredentials = null;
    $("connect-save-button").disabled = true;
    $("connect-message").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    $("connect-test-button").disabled = false;
  }
}

async function saveBinanceConnection() {
  const account = accountState.activeAccount;
  if (!account || !accountState.testedCredentials) return;
  $("connect-save-button").disabled = true;
  $("connect-message").textContent = "Saving connection";
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
    $("connect-message").textContent = error instanceof Error ? error.message : String(error);
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
  $("delete-account-confirm-message").textContent = "";
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
  $("delete-account-confirm-message").textContent = "Deleting account";
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
    $("delete-account-confirm-message").textContent = error instanceof Error ? error.message : String(error);
    $("confirm-delete-account-button").disabled = $("delete-account-confirm-input").value !== account.name;
  } finally {
    $("cancel-delete-account-button").disabled = false;
  }
}

async function handleDeletedAccount(deletedAccountId) {
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
  await setActiveTradingAccount(accountState.accounts[0]);
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
  if (!snapshotResponse.ok) throw new Error(`Snapshot request failed: ${snapshotResponse.status}`);
  const snapshot = await snapshotResponse.json();
  if (sequence !== dashboardRequestSequence || accountId !== accountState.activeAccount?.id || activeView !== "home") return;
  const engine = snapshot.engine ?? {};
  const runtime = snapshot.runtime ?? {};
  const store = snapshot.store ?? {};
  const account = snapshot.binanceAccount ?? runtime.account ?? {};
  const connection = snapshot.connection ?? {};
  const runtimeHealth = snapshot.runtimeHealth ?? {};
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

  $("engine-state").textContent = engine.setupState ?? "-";
  const execution = snapshot.execution ?? runtimeHealth.execution ?? {
    enabled: Boolean(runtimeHealth.executionEnabled),
    reason: runtimeHealth.executionEnabled ? "READY" : "RECONCILIATION_REQUIRED",
  };
  const executionLabel = execution.enabled ? "ENABLED" : "DISABLED";
  const executionReason = execution.reason ? ` · ${execution.reason}` : "";
  const realReadiness = snapshot.realReadiness ?? null;
  const readinessText = realReadiness
    ? ` · Mode ${realReadiness.realExecutionMode} · Account readiness ${realReadiness.accountReady ? "READY" : "NOT READY"} · Master Live Execution ${realReadiness.masterLiveExecutionEnabled ? "UNLOCKED" : "LOCKED BY SERVER"} · Execution LOCKED · ${realReadiness.executionReason}`
    : "";
  const reconciliationError = runtimeHealth.lastReconciliationError ? ` · Error ${runtimeHealth.lastReconciliationError}` : "";
  $("engine-detail").textContent =
    `Runtime ${runtimeHealth.state ?? "-"} · Reconciliation ${runtimeHealth.reconciliationStatus ?? "-"} · Execution ${executionLabel}${executionReason}${readinessText}${reconciliationError} · Risk 1R ${formatUsdt(runtime.risk?.riskPerTradeUsdt)} · Max leverage ${runtime.risk?.maxLeverage ?? "-"}x`;
  $("daily-entry-status").textContent = dailyRisk ? dailyEntryStatusLabel(dailyRisk) : "-";
  $("daily-risk-detail").textContent = dailyRisk
    ? `Today Realized PnL: ${formatSignedNumber(dailyRisk.realizedR)}R (${formatSignedUsdt(dailyRisk.realizedPnlUsdt)}) · Daily Range: -${dailyRisk.dailyLossLimitR}R → +${dailyRisk.dailyProfitLimitR}R`
    : "Daily status unavailable";
  $("account-protection-status").textContent = accountProtection ? accountProtectionStatusLabel(accountProtection) : "-";
  $("account-protection-detail").textContent = accountProtection
    ? `Current Drawdown: ${formatSignedNumber(accountProtection.drawdownPercent)}% · Max Drawdown: ${accountProtection.maxDrawdownPercent}%`
    : "Account protection unavailable";

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
  load().catch((error) => {
    if (activeView === "home") console.error(userFacingApiError(error));
  });
}

function pollChartOnce() {
  loadChart().catch((error) => {
    if (activeView === "chart") $("chart-status").textContent = userFacingApiError(error);
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
        tableCell(item.conditions === undefined || item.conditions === null ? "—" : item.conditions),
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
document.querySelectorAll("[data-setting-group]").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[data-setting-value]");
    if (!button) return;
    settingsState[group.dataset.settingGroup] = button.dataset.settingValue;
    renderSettings();
    saveSettings();
  });
});
function showView(view) {
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
    hideOtherSymbolsInput: $("hide-other-symbols"),
  });
}

async function loadChart() {
  try {
    await ensureChart();
    if (activeView !== "chart") return;
    const accountId = accountState.activeAccount?.id;
    if (!accountId) {
      $("chart-status").textContent = "Select a trading account";
      return;
    }
    const symbol = $("chart-symbol").value.trim().toUpperCase() || DEFAULT_SYMBOL;
    const interval = $("chart-interval").value;
    $("chart-symbol").value = symbol;
    rememberChartInputs(symbol, interval);
    await chartState.instance.load({ accountId, symbol, interval, limit: 300 });
  } catch (error) {
    if (activeView !== "chart") return;
    $("chart-status").textContent = error instanceof Error ? error.message : String(error);
  }
}

function resizeChart() {
  chartState.instance?.resize();
}

async function loadAnalysis() {
  const accountId = accountState.activeAccount?.id;
  const sequence = ++analysisRequestSequence;
  const symbol = $("analysis-symbol").value.trim().toUpperCase() || DEFAULT_SYMBOL;
  $("analysis-symbol").value = symbol;
  rememberAnalysisSymbol(symbol);
  if (!accountId) {
    $("analysis-status").textContent = "Select a trading account";
    return;
  }
  $("analysis-status").textContent = `Analyzing ${symbol}`;
  $("analysis-run").disabled = true;

  try {
    const path = `/api/trading-accounts/${accountId}/analysis?symbol=${encodeURIComponent(symbol)}`;
    const response = await apiFetch(path);
    if (sequence !== analysisRequestSequence || accountId !== accountState.activeAccount?.id) return;
    if (handleUnauthorized(response)) return;
    if (!response.ok) throw new Error(`Analysis request failed: ${response.status}`);
    renderAnalysis(await response.json());
  } catch (error) {
    if (sequence !== analysisRequestSequence || accountId !== accountState.activeAccount?.id) return;
    $("analysis-status").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (sequence === analysisRequestSequence) $("analysis-run").disabled = false;
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
  const riskChecks = [...(risk.checks ?? [])];
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
  $("settings-status").textContent = "Loading";
  try {
    const [response, symbolsResponse, watchlistResponse] = await Promise.all([
      apiFetch(settingsPath),
      apiFetch(symbolsPath),
      apiFetch(watchlistPath),
    ]);
    if (sequence !== settingsRequestSequence || accountId !== (accountState.activeAccount?.id ?? null)) return;
    if (handleUnauthorized(response) || handleUnauthorized(symbolsResponse) || handleUnauthorized(watchlistResponse)) return;
    if (!response.ok) throw new Error(`Settings request failed: ${response.status}`);
    if (!symbolsResponse.ok) throw new Error(`Symbols request failed: ${symbolsResponse.status}`);
    if (!watchlistResponse.ok) throw new Error(`Watchlist request failed: ${watchlistResponse.status}`);
    marketSymbols = await symbolsResponse.json();
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
    $("settings-status").textContent = "Loaded";
  } catch {
    if (sequence !== settingsRequestSequence || accountId !== (accountState.activeAccount?.id ?? null)) return;
    Object.assign(settingsState, defaultSettings);
    marketSymbols = [];
    $("settings-status").textContent = "Load failed";
  }
  renderSettings();
}

function renderSettings() {
  renderWatchlistSettings();
  renderRealSafety();
  $("setting-risk-per-trade").value = settingsState.riskPerTradeUsdt;
  $("setting-max-leverage").value = settingsState.maxLeverage;
  $("setting-max-margin-usage").value = settingsState.maxMarginUsagePercent;
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
  updateConditionalSettingVisibility();

  document.querySelectorAll("[data-setting-group]").forEach((group) => {
    const value = settingsState[group.dataset.settingGroup];
    group.querySelectorAll("[data-setting-value]").forEach((button) => {
      button.classList.toggle("active", button.dataset.settingValue === value);
    });
  });
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
  $("settings-status").textContent = "Saving REAL execution mode";
  const response = await apiFetch(`/api/trading-accounts/${account.id}/real-execution-mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (handleUnauthorized(response)) return;
  if (!response.ok) {
    $("settings-status").textContent = `Mode save failed: ${response.status}`;
    return;
  }
  const body = await response.json();
  realSafetyState.mode = body.mode ?? "LOCKED";
  realSafetyState.masterLiveExecutionEnabled = Boolean(body.masterLiveExecutionEnabled);
  settingsState.realExecutionMode = realSafetyState.mode;
  renderRealSafety();
  await loadRealProposals(account.id);
  $("settings-status").textContent = "REAL execution mode saved";
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
  $("settings-status").textContent = response.ok ? "Proposal updated" : `Proposal update failed: ${response.status}`;
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
  $("settings-status").textContent = value === "" ? `${rule.label} is required` : "Unsaved changes";
}

async function saveSettings() {
  const accountId = accountState.activeAccount?.id ?? null;
  if (!accountId) {
    $("settings-status").textContent = "Select a trading account";
    return;
  }
  const validation = validateSettingsDraft();
  if (!validation.ok) {
    $("settings-status").textContent = validation.message;
    validation.element?.focus();
    return;
  }
  const settingsPath = `/api/trading-accounts/${accountId}/settings`;
  $("settings-status").textContent = "Saving";
  const payload = settingsPayload();
  const response = await apiFetch(settingsPath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (accountId !== (accountState.activeAccount?.id ?? null)) return;
  if (handleUnauthorized(response)) return;
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
    riskPerTradeUsdt: String(settings.riskPerTradeUsdt ?? defaultSettings.riskPerTradeUsdt),
    maxLeverage: String(settings.maxLeverage ?? defaultSettings.maxLeverage),
    maxMarginUsagePercent: String(settings.maxMarginUsagePercent ?? defaultSettings.maxMarginUsagePercent),
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
  };
}

function settingsPayload() {
  const watchlist = getSelectedWatchlist();
  return {
    watchlist,
    symbol: watchlist[0] ?? "BTCUSDT",
    positionSizingMode: settingsState.positionSizingMode,
    riskPerTradeUsdt: settingNumber("riskPerTradeUsdt"),
    maxLeverage: settingNumber("maxLeverage"),
    maxMarginUsagePercent: settingNumber("maxMarginUsagePercent"),
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
};

const numericSettingRules = {
  riskPerTradeUsdt: { id: "setting-risk-per-trade", label: "Risk per Trade", min: 0, exclusiveMin: true },
  maxLeverage: { id: "setting-max-leverage", label: "Max Leverage", min: 1, max: 125, integer: true },
  maxMarginUsagePercent: { id: "setting-max-margin-usage", label: "Max Margin Usage", min: 0, exclusiveMin: true, max: 100 },
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
