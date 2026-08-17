import crypto from "node:crypto";
import argon2 from "argon2";
import { z } from "zod";
import type { AuthRepository } from "./AuthRepository.js";
import { DuplicateEmailError } from "./AuthRepository.js";
import type { SafeUser, User } from "../../domain/auth/User.js";
import { toSafeUser } from "../../domain/auth/User.js";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(256)
});

const sessionTtlMs = 1000 * 60 * 60 * 24 * 30;

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
  }
}

export class InvalidAuthInputError extends Error {
  constructor(message = "Invalid authentication request") {
    super(message);
  }
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly sessionSecret: string
  ) {}

  async register(input: unknown): Promise<{ user: SafeUser; sessionToken: string; expiresAt: string }> {
    const credentials = parseCredentials(input);
    const now = new Date().toISOString();
    const user: User = {
      id: crypto.randomUUID(),
      email: credentials.email,
      passwordHash: await argon2.hash(credentials.password, { type: argon2.argon2id }),
      createdAt: now,
      updatedAt: now
    };

    const created = await this.repository.createUser(user);
    const session = await this.createSession(created.id);
    return { user: toSafeUser(created), ...session };
  }

  async login(input: unknown): Promise<{ user: SafeUser; sessionToken: string; expiresAt: string }> {
    const credentials = parseCredentials(input);
    const user = await this.repository.findUserByEmail(credentials.email);
    if (!user) throw new InvalidCredentialsError();

    const validPassword = await argon2.verify(user.passwordHash, credentials.password);
    if (!validPassword) throw new InvalidCredentialsError();

    const session = await this.createSession(user.id);
    return { user: toSafeUser(user), ...session };
  }

  async currentUser(sessionToken: string | null): Promise<SafeUser | null> {
    if (!sessionToken) return null;
    const tokenHash = this.hashSessionToken(sessionToken);
    const session = await this.repository.findSessionByTokenHash(tokenHash);
    if (!session) return null;

    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.repository.deleteSessionByTokenHash(tokenHash);
      return null;
    }

    const user = await this.repository.findUserById(session.userId);
    return user ? toSafeUser(user) : null;
  }

  async logout(sessionToken: string | null): Promise<void> {
    if (!sessionToken) return;
    await this.repository.deleteSessionByTokenHash(this.hashSessionToken(sessionToken));
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.repository.deleteExpiredSessions(new Date().toISOString());
  }

  private async createSession(userId: string): Promise<{ sessionToken: string; expiresAt: string }> {
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
    const now = new Date().toISOString();
    await this.repository.createSession({
      id: crypto.randomUUID(),
      userId,
      tokenHash: this.hashSessionToken(sessionToken),
      expiresAt,
      createdAt: now
    });
    return { sessionToken, expiresAt };
  }

  private hashSessionToken(sessionToken: string): string {
    return crypto.createHmac("sha256", this.sessionSecret).update(sessionToken).digest("hex");
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseCredentials(input: unknown): { email: string; password: string } {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAuthInputError("Email must be valid and password must be at least 8 characters");
  }
  return {
    email: normalizeEmail(parsed.data.email),
    password: parsed.data.password
  };
}

export function isDuplicateEmailError(error: unknown): error is DuplicateEmailError {
  return error instanceof DuplicateEmailError;
}
