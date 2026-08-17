import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/application/auth/AuthService.js";
import { defaultTradingSettings, type AppConfig } from "../src/application/config/AppConfig.js";
import { createHttpHandler } from "../src/presentation/http/Server.js";
import { MemoryAuthRepository } from "../src/infrastructure/auth/MemoryAuthRepository.js";
import { MemoryTradingRepository } from "../src/infrastructure/persistence/MemoryTradingRepository.js";
import type { AuthRepository } from "../src/application/auth/AuthRepository.js";
import type { User, UserSession } from "../src/domain/auth/User.js";
import type { TradingEngine } from "../src/application/engine/TradingEngine.js";
import type { DecisionLogger } from "../src/application/ports/Logger.js";

const sessionSecret = "test-session-secret-with-at-least-thirty-two-chars";

describe("AuthService password hashing", () => {
  it("stores a new registration password as Argon2id", async () => {
    const repository = new CapturingAuthRepository();
    const auth = new AuthService(repository, sessionSecret);

    await auth.register({
      email: "  USER@Example.COM ",
      password: "password123"
    });

    expect(repository.createdUser?.email).toBe("user@example.com");
    expect(repository.createdUser?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(repository.createdUser?.passwordHash).not.toContain("password123");
  });
});

describe("auth HTTP flow", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const auth = new AuthService(new MemoryAuthRepository(), sessionSecret);
    const repository = new MemoryTradingRepository();
    const engine = fakeEngine();
    const logger = fakeLogger();
    server = createServer(
      createHttpHandler({
        port: 0,
        config: testConfig(),
        engine,
        repository,
        logger,
        auth
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("registers a user and normalizes email", async () => {
    const response = await postJson("/api/auth/register", {
      email: "  USER@Example.COM ",
      password: "password123"
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("smc_session=");
    expect(await response.json()).toMatchObject({
      user: { email: "user@example.com" }
    });
  });

  it("rejects duplicate registration", async () => {
    await register();
    const response = await postJson("/api/auth/register", {
      email: "user@example.com",
      password: "password123"
    });

    expect(response.status).toBe(409);
  });

  it("logs in with valid credentials and rejects wrong password generically", async () => {
    await register();

    const bad = await postJson("/api/auth/login", {
      email: "user@example.com",
      password: "wrong-password"
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "Invalid email or password" });

    const good = await postJson("/api/auth/login", {
      email: "USER@example.com",
      password: "password123"
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toContain("smc_session=");
  });

  it("returns current user only with a valid session", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/auth/me`);
    expect(unauthenticated.status).toBe(401);

    const cookie = await register();
    const authenticated = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie }
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({
      user: { email: "user@example.com" }
    });
  });

  it("logs out and invalidates the session", async () => {
    const cookie = await register();
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie }
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie }
    });
    expect(me.status).toBe(401);
  });

  it("protects existing trading endpoints", async () => {
    const blocked = await fetch(`${baseUrl}/api/trading-accounts`);
    expect(blocked.status).toBe(401);

    const cookie = await register();
    const allowed = await fetch(`${baseUrl}/api/trading-accounts`, {
      headers: { cookie }
    });
    expect(allowed.status).not.toBe(401);
  });

  async function register(): Promise<string> {
    const response = await postJson("/api/auth/register", {
      email: "user@example.com",
      password: "password123"
    });
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("Expected session cookie");
    return cookie;
  }

  function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }
});

class CapturingAuthRepository implements AuthRepository {
  createdUser: User | null = null;
  private readonly sessions = new Map<string, UserSession>();

  async createUser(user: User): Promise<User> {
    this.createdUser = user;
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.createdUser?.email === email ? this.createdUser : null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.createdUser?.id === id ? this.createdUser : null;
  }

  async createSession(session: UserSession): Promise<UserSession> {
    this.sessions.set(session.tokenHash, session);
    return session;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<UserSession | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteExpiredSessions(): Promise<void> {
    return undefined;
  }
}

function testConfig(): AppConfig {
  return {
    ...defaultTradingSettings,
    port: 8787,
    executionMode: "paper",
    logLevel: "info",
    corsOrigins: ["http://localhost:5173"],
    databaseUrl: undefined,
    sessionSecret,
    binanceCredentialEncryptionKey: "1111111111111111111111111111111111111111111111111111111111111111",
    binanceApiKey: undefined,
    binanceApiSecret: undefined,
    binanceTestnet: true
  };
}

function fakeEngine(): TradingEngine {
  return {
    getDashboardState: () => ({
      setupState: "WaitingTrend",
      trend: "neutral",
      balance: 10_000,
      candleCounts: { H1: 0, M5: 0 },
      pendingSetup: null,
      activeRisk: null
    })
  } as unknown as TradingEngine;
}

function fakeLogger(): DecisionLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
