import type { AuthRepository } from "../../application/auth/AuthRepository.js";
import { DuplicateEmailError } from "../../application/auth/AuthRepository.js";
import type { User, UserSession } from "../../domain/auth/User.js";

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, User>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, UserSession>();

  async createUser(user: User): Promise<User> {
    if (this.usersByEmail.has(user.email)) {
      throw new DuplicateEmailError();
    }

    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
    return user;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const id = this.usersByEmail.get(email);
    return id ? this.users.get(id) ?? null : null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
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

  async deleteExpiredSessions(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    for (const [tokenHash, session] of this.sessions.entries()) {
      if (Date.parse(session.expiresAt) <= now) {
        this.sessions.delete(tokenHash);
      }
    }
  }
}
