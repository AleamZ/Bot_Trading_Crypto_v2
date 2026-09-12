export interface EffectiveExecutionPolicy {
  processReadOnlySoak: boolean;
  accountReadOnlySoak: boolean;
  effectiveReadOnlySoak: boolean;
  executionPolicy: "READ_ONLY_SOAK" | "NORMAL";
  executionCapability: "BLOCKED_READ_ONLY" | "CONFIGURED";
}

export function resolveEffectiveExecutionPolicy(processReadOnlySoak: boolean, accountReadOnlySoak: boolean): EffectiveExecutionPolicy {
  const effectiveReadOnlySoak = processReadOnlySoak || accountReadOnlySoak;
  return {
    processReadOnlySoak,
    accountReadOnlySoak,
    effectiveReadOnlySoak,
    executionPolicy: effectiveReadOnlySoak ? "READ_ONLY_SOAK" : "NORMAL",
    executionCapability: effectiveReadOnlySoak ? "BLOCKED_READ_ONLY" : "CONFIGURED"
  };
}
