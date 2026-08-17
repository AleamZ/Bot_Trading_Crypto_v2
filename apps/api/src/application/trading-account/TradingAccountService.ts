import crypto from "node:crypto";
import { z } from "zod";
import type { BinanceAccountVerifier, BinanceAccountInfo } from "./BinanceAccountVerifier.js";
import { BinanceVerificationError } from "./BinanceAccountVerifier.js";
import type { TradingAccountRepository } from "./TradingAccountRepository.js";
import type { TradingRuntimeConfigRepository } from "./TradingRuntimeConfigRepository.js";
import { validateTradingSettings, type TradingSettings } from "../config/AppConfig.js";
import type { CredentialCipher } from "../../infrastructure/security/CredentialCipher.js";
import type {
  BinanceConnection,
  SafeBinanceAccount,
  SafeBinanceConnection,
  SafeTradingAccount,
  TradingAccount,
  TradingAccountMode
} from "../../domain/trading-account/TradingAccount.js";
import { maskApiKey, modeEnvironment, toSafeTradingAccount } from "../../domain/trading-account/TradingAccount.js";

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["DEMO", "REAL"])
});

const credentialsSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(512)
});

export class TradingAccountNotFoundError extends Error {
  constructor() {
    super("Trading account not found");
  }
}

export class InvalidTradingAccountInputError extends Error {
  constructor(message = "Invalid trading account request") {
    super(message);
  }
}

export class TradingAccountService {
  constructor(
    private readonly repository: TradingAccountRepository,
    private readonly cipher: CredentialCipher,
    private readonly verifier: BinanceAccountVerifier,
    private readonly runtimeConfigRepository: TradingRuntimeConfigRepository | null = null,
    private readonly defaultSettings: TradingSettings | null = null
  ) {}

  async listAccounts(userId: string): Promise<SafeTradingAccount[]> {
    const accounts = await this.repository.listTradingAccounts(userId);
    await Promise.all(accounts.map((account) => this.ensureRuntimeDefaults(account.id)));
    return accounts.map(toSafeTradingAccount);
  }

  async createAccount(userId: string, input: unknown): Promise<SafeTradingAccount> {
    const parsed = createAccountSchema.safeParse(input);
    if (!parsed.success) throw new InvalidTradingAccountInputError("Account name and mode are required");
    const now = new Date().toISOString();
    const account = await this.repository.createTradingAccount({
      id: crypto.randomUUID(),
      userId,
      name: parsed.data.name,
      mode: parsed.data.mode,
      status: "PENDING",
      createdAt: now,
      updatedAt: now
    });
    await this.ensureRuntimeDefaults(account.id);
    return toSafeTradingAccount(account);
  }

  async getOwnedAccount(userId: string, accountId: string): Promise<TradingAccount> {
    const account = await this.repository.findTradingAccountById(accountId);
    if (!account || account.userId !== userId) throw new TradingAccountNotFoundError();
    return account;
  }

  async getAccount(userId: string, accountId: string): Promise<SafeTradingAccount> {
    const account = await this.getOwnedAccount(userId, accountId);
    await this.ensureRuntimeDefaults(account.id);
    return toSafeTradingAccount(account);
  }

  async getSettings(userId: string, accountId: string): Promise<TradingSettings> {
    const account = await this.getOwnedAccount(userId, accountId);
    await this.ensureRuntimeDefaults(account.id);
    const settings = await this.runtimeConfigRepository?.getSettings(account.id);
    if (!settings) throw new InvalidTradingAccountInputError("Trading settings are unavailable");
    return settings;
  }

  async saveSettings(userId: string, accountId: string, input: unknown): Promise<TradingSettings> {
    const account = await this.getOwnedAccount(userId, accountId);
    const settings = validateTradingSettings(input);
    await this.runtimeConfigRepository?.saveSettings(account.id, settings);
    await this.runtimeConfigRepository?.saveWatchlist(account.id, settings.watchlist);
    return settings;
  }

  async getWatchlist(userId: string, accountId: string): Promise<string[]> {
    const account = await this.getOwnedAccount(userId, accountId);
    await this.ensureRuntimeDefaults(account.id);
    return (await this.runtimeConfigRepository?.getWatchlist(account.id)) ?? [];
  }

  async saveWatchlist(userId: string, accountId: string, input: unknown): Promise<string[]> {
    const account = await this.getOwnedAccount(userId, accountId);
    const nextWatchlist = Array.isArray(input) ? input : typeof input === "object" && input !== null ? (input as { watchlist?: unknown }).watchlist : [];
    const current = await this.getSettings(userId, accountId);
    const settings = validateTradingSettings({ ...current, watchlist: nextWatchlist });
    await this.runtimeConfigRepository?.saveSettings(account.id, settings);
    await this.runtimeConfigRepository?.saveWatchlist(account.id, settings.watchlist);
    return settings.watchlist;
  }

  async getConnection(userId: string, accountId: string): Promise<SafeBinanceConnection> {
    await this.getOwnedAccount(userId, accountId);
    return this.toSafeConnection(await this.repository.findBinanceConnection(accountId));
  }

  async testConnection(userId: string, accountId: string, input: unknown): Promise<{ connection: SafeBinanceConnection; account: SafeBinanceAccount }> {
    const account = await this.getOwnedAccount(userId, accountId);
    const credentials = parseCredentials(input);
    const info = await this.verifyCredentials(account.mode, credentials);
    return {
      connection: {
        id: null,
        status: "CONNECTED",
        apiKeyMasked: maskApiKey(credentials.apiKey),
        lastVerifiedAt: info.checkedAt,
        lastError: null
      },
      account: toSafeBinanceAccount(info)
    };
  }

  async saveConnection(userId: string, accountId: string, input: unknown): Promise<{ connection: SafeBinanceConnection; account: SafeBinanceAccount }> {
    const account = await this.getOwnedAccount(userId, accountId);
    const credentials = parseCredentials(input);
    const info = await this.verifyCredentials(account.mode, credentials);
    const now = new Date().toISOString();
    const existing = await this.repository.findBinanceConnection(account.id);
    const connection: BinanceConnection = {
      id: existing?.id ?? crypto.randomUUID(),
      tradingAccountId: account.id,
      apiKeyEncrypted: this.cipher.encrypt(credentials.apiKey),
      apiSecretEncrypted: this.cipher.encrypt(credentials.apiSecret),
      credentialVersion: 1,
      status: "CONNECTED",
      lastVerifiedAt: info.checkedAt,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const saved = await this.repository.upsertBinanceConnection(connection);
    await this.repository.updateTradingAccountStatus(account.id, "CONNECTED", now);
    return { connection: this.toSafeConnection(saved), account: toSafeBinanceAccount(info) };
  }

  async disconnect(userId: string, accountId: string): Promise<SafeBinanceConnection> {
    const account = await this.getOwnedAccount(userId, accountId);
    await this.repository.deleteBinanceConnection(account.id);
    await this.repository.updateTradingAccountStatus(account.id, "DISCONNECTED", new Date().toISOString());
    return this.toSafeConnection(null);
  }

  async getBinanceAccount(userId: string, accountId: string): Promise<SafeBinanceAccount> {
    const account = await this.getOwnedAccount(userId, accountId);
    const connection = await this.repository.findBinanceConnection(account.id);
    if (!connection || connection.status !== "CONNECTED") {
      return {
        environment: modeEnvironment(account.mode),
        connected: false,
        walletBalance: null,
        availableBalance: null,
        currency: "USDT",
        checkedAt: new Date().toISOString()
      };
    }

    const apiKey = this.cipher.decrypt(connection.apiKeyEncrypted);
    const apiSecret = this.cipher.decrypt(connection.apiSecretEncrypted);
    try {
      return toSafeBinanceAccount(await this.verifier.verify({ mode: account.mode, apiKey, apiSecret }));
    } catch (error) {
      const code = error instanceof BinanceVerificationError ? error.code : "BINANCE_UNAVAILABLE";
      await this.repository.updateTradingAccountStatus(account.id, "ERROR", new Date().toISOString());
      return {
        environment: modeEnvironment(account.mode),
        connected: false,
        walletBalance: null,
        availableBalance: null,
        currency: "USDT",
        checkedAt: new Date().toISOString()
      };
    }
  }

  private async verifyCredentials(mode: TradingAccountMode, credentials: { apiKey: string; apiSecret: string }): Promise<BinanceAccountInfo> {
    try {
      return await this.verifier.verify({ mode, ...credentials });
    } catch (error) {
      if (error instanceof BinanceVerificationError) throw error;
      throw new BinanceVerificationError("BINANCE_UNAVAILABLE", "Binance Futures account verification is unavailable");
    }
  }

  private toSafeConnection(connection: BinanceConnection | null): SafeBinanceConnection {
    if (!connection) {
      return {
        id: null,
        status: "NOT_CONFIGURED",
        apiKeyMasked: null,
        lastVerifiedAt: null,
        lastError: null
      };
    }

    return {
      id: connection.id,
      status: connection.status,
      apiKeyMasked: maskApiKey(this.cipher.decrypt(connection.apiKeyEncrypted)),
      lastVerifiedAt: connection.lastVerifiedAt,
      lastError: connection.lastError
    };
  }

  private async ensureRuntimeDefaults(tradingAccountId: string): Promise<void> {
    if (!this.runtimeConfigRepository || !this.defaultSettings) return;
    await this.runtimeConfigRepository.ensureDefaults(tradingAccountId, this.defaultSettings);
  }
}

function parseCredentials(input: unknown): { apiKey: string; apiSecret: string } {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new InvalidTradingAccountInputError("Binance API key and secret are required");
  return parsed.data;
}

function toSafeBinanceAccount(info: BinanceAccountInfo): SafeBinanceAccount {
  return {
    environment: info.environment,
    connected: info.connected,
    walletBalance: info.walletBalance,
    availableBalance: info.availableBalance,
    currency: info.currency,
    checkedAt: info.checkedAt
  };
}
