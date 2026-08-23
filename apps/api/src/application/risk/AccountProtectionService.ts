export interface AccountProtectionState {
  tradingAccountId: string;
  baselineEquityUsdt: number;
  peakEquityUsdt: number;
  maxDrawdownReachedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountProtectionStatus {
  tradingAccountId: string;
  currentEquityUsdt: number;
  baselineEquityUsdt: number;
  peakEquityUsdt: number;
  drawdownPercent: number;
  maxDrawdownPercent: number;
  newEntriesAllowed: boolean;
  blockReason: AccountProtectionBlockReason | null;
  maxDrawdownReachedAt: string | null;
}

export type AccountProtectionBlockReason = "MAX_DRAWDOWN_REACHED";

export interface AccountProtectionUpdate {
  state: AccountProtectionState;
  status: AccountProtectionStatus;
  changed: boolean;
}

export function updateAccountProtectionState(input: {
  tradingAccountId: string;
  currentEquityUsdt: number;
  maxDrawdownPercent: number;
  state: AccountProtectionState | null;
  now?: Date;
}): AccountProtectionUpdate {
  if (!Number.isFinite(input.currentEquityUsdt) || input.currentEquityUsdt <= 0) {
    throw new Error("ACCOUNT_PROTECTION_EQUITY_UNAVAILABLE");
  }
  if (!Number.isFinite(input.maxDrawdownPercent) || input.maxDrawdownPercent <= 0) {
    throw new Error("ACCOUNT_PROTECTION_INVALID_LIMIT");
  }

  const now = (input.now ?? new Date()).toISOString();
  const existing = input.state;
  let state: AccountProtectionState = existing
    ? { ...existing }
    : {
        tradingAccountId: input.tradingAccountId,
        baselineEquityUsdt: input.currentEquityUsdt,
        peakEquityUsdt: input.currentEquityUsdt,
        maxDrawdownReachedAt: null,
        createdAt: now,
        updatedAt: now
      };
  let changed = !existing;

  if (state.tradingAccountId !== input.tradingAccountId) throw new Error("ACCOUNT_PROTECTION_ACCOUNT_MISMATCH");
  if (!Number.isFinite(state.peakEquityUsdt) || state.peakEquityUsdt <= 0) throw new Error("ACCOUNT_PROTECTION_STATE_INVALID");

  if (!state.maxDrawdownReachedAt && input.currentEquityUsdt > state.peakEquityUsdt) {
    state = { ...state, peakEquityUsdt: input.currentEquityUsdt, updatedAt: now };
    changed = true;
  }

  const drawdownPercent = calculateDrawdownPercent(state.peakEquityUsdt, input.currentEquityUsdt);
  if (!state.maxDrawdownReachedAt && drawdownPercent >= input.maxDrawdownPercent) {
    state = { ...state, maxDrawdownReachedAt: now, updatedAt: now };
    changed = true;
  }

  return {
    state,
    changed,
    status: {
      tradingAccountId: input.tradingAccountId,
      currentEquityUsdt: input.currentEquityUsdt,
      baselineEquityUsdt: state.baselineEquityUsdt,
      peakEquityUsdt: state.peakEquityUsdt,
      drawdownPercent,
      maxDrawdownPercent: input.maxDrawdownPercent,
      newEntriesAllowed: state.maxDrawdownReachedAt === null,
      blockReason: state.maxDrawdownReachedAt ? "MAX_DRAWDOWN_REACHED" : null,
      maxDrawdownReachedAt: state.maxDrawdownReachedAt
    }
  };
}

function calculateDrawdownPercent(peakEquityUsdt: number, currentEquityUsdt: number): number {
  return Math.max(0, ((peakEquityUsdt - currentEquityUsdt) / peakEquityUsdt) * 100);
}
