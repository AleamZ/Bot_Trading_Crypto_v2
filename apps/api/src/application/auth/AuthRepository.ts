import type { User, UserSession } from "../../domain/auth/User.js";

export class DuplicateEmailError extends Error {
  constructor() {
    super("Email already exists");
  }
}

export interface AuthRepository {
  createUser(user: User): Promise<User>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createSession(session: UserSession): Promise<UserSession>;
  findSessionByTokenHash(tokenHash: string): Promise<UserSession | null>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  deleteExpiredSessions(nowIso: string): Promise<void>;
}
