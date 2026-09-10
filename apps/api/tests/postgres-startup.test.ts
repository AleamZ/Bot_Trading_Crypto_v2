import { afterEach, describe, expect, it } from "vitest";
import { withPostgresStartupRetry } from "../src/infrastructure/persistence/PgPoolFactory.js";

const originalAttempts = process.env.POSTGRES_STARTUP_MAX_ATTEMPTS;
const originalDelay = process.env.POSTGRES_STARTUP_RETRY_DELAY_MS;

afterEach(() => {
  if (originalAttempts === undefined) delete process.env.POSTGRES_STARTUP_MAX_ATTEMPTS;
  else process.env.POSTGRES_STARTUP_MAX_ATTEMPTS = originalAttempts;
  if (originalDelay === undefined) delete process.env.POSTGRES_STARTUP_RETRY_DELAY_MS;
  else process.env.POSTGRES_STARTUP_RETRY_DELAY_MS = originalDelay;
});

describe("PostgreSQL startup retry", () => {
  it("retries transient connection resets and succeeds", async () => {
    process.env.POSTGRES_STARTUP_MAX_ATTEMPTS = "3";
    process.env.POSTGRES_STARTUP_RETRY_DELAY_MS = "1";
    let attempts = 0;

    await expect(
      withPostgresStartupRetry("test connection", async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        return "connected";
      })
    ).resolves.toBe("connected");
    expect(attempts).toBe(2);
  });

  it("does not retry non-transient database errors", async () => {
    process.env.POSTGRES_STARTUP_MAX_ATTEMPTS = "3";
    process.env.POSTGRES_STARTUP_RETRY_DELAY_MS = "1";
    let attempts = 0;

    await expect(
      withPostgresStartupRetry("test migration", async () => {
        attempts += 1;
        throw Object.assign(new Error("duplicate object"), { code: "42P07" });
      })
    ).rejects.toThrow("duplicate object");
    expect(attempts).toBe(1);
  });

  it("keeps the final transient failure visible after bounded retries", async () => {
    process.env.POSTGRES_STARTUP_MAX_ATTEMPTS = "2";
    process.env.POSTGRES_STARTUP_RETRY_DELAY_MS = "1";
    let attempts = 0;

    await expect(
      withPostgresStartupRetry("test readiness", async () => {
        attempts += 1;
        throw Object.assign(new Error("database unavailable"), { code: "ECONNRESET" });
      })
    ).rejects.toThrow("database unavailable");
    expect(attempts).toBe(2);
  });

  it("treats a PostgreSQL query read timeout as transient during startup reads", async () => {
    process.env.POSTGRES_STARTUP_MAX_ATTEMPTS = "2";
    process.env.POSTGRES_STARTUP_RETRY_DELAY_MS = "1";
    let attempts = 0;

    await expect(
      withPostgresStartupRetry("test dashboard read", async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Query read timeout");
        return "read";
      })
    ).resolves.toBe("read");
    expect(attempts).toBe(2);
  });
});
