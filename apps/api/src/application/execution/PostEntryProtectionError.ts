import type { SubmittedOrder } from "../ports/ExecutionGateway.js";

export class PostEntryProtectionError extends Error {
  constructor(
    message: string,
    readonly submittedOrder: SubmittedOrder
  ) {
    super(message);
    this.name = "PostEntryProtectionError";
  }
}

export function isPostEntryProtectionError(error: unknown): error is PostEntryProtectionError {
  return error instanceof PostEntryProtectionError;
}
