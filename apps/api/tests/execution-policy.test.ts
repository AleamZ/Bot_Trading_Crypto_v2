import { describe, expect, it } from "vitest";
import { resolveEffectiveExecutionPolicy } from "../src/application/runtime/ExecutionPolicy.js";

describe("effective execution policy", () => {
  it.each([
    [true, false, true],
    [true, true, true],
    [false, true, true],
    [false, false, false]
  ])("applies process OR account precedence: process=%s account=%s effective=%s", (processReadOnly, accountReadOnly, effective) => {
    expect(resolveEffectiveExecutionPolicy(processReadOnly, accountReadOnly).effectiveReadOnlySoak).toBe(effective);
  });

  it("keeps the process safety ceiling across account refresh and runtime reinitialization", () => {
    const startup = resolveEffectiveExecutionPolicy(true, false);
    const refresh = resolveEffectiveExecutionPolicy(startup.processReadOnlySoak, false);
    const reinitialize = resolveEffectiveExecutionPolicy(refresh.processReadOnlySoak, false);
    const reconnect = resolveEffectiveExecutionPolicy(reinitialize.processReadOnlySoak, false);

    expect([startup, refresh, reinitialize, reconnect].every((policy) => policy.effectiveReadOnlySoak)).toBe(true);
    expect(reconnect.executionPolicy).toBe("READ_ONLY_SOAK");
    expect(reconnect.executionCapability).toBe("BLOCKED_READ_ONLY");
  });
});
