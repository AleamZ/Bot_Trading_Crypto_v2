import type { CreateRealExecutionProposalInput, RealExecutionProposal, RealExecutionProposalStatus } from "./RealExecutionProposal.js";

export interface RealExecutionProposalRepository {
  createOrGet(input: CreateRealExecutionProposalInput): Promise<{ proposal: RealExecutionProposal; created: boolean }>;
  findById(tradingAccountId: string, proposalId: string): Promise<RealExecutionProposal | null>;
  findBySetupKey(tradingAccountId: string, setupKey: string): Promise<RealExecutionProposal | null>;
  listByAccount(tradingAccountId: string, limit?: number): Promise<RealExecutionProposal[]>;
  transitionStatus(
    tradingAccountId: string,
    proposalId: string,
    expected: RealExecutionProposalStatus[],
    next: RealExecutionProposalStatus,
    patch?: Partial<Pick<RealExecutionProposal, "approvedAt" | "approvedByUserId" | "rejectedAt" | "cancelledAt" | "executedAt" | "executionIntentId">>
  ): Promise<RealExecutionProposal | null>;
  expireOpen(nowIso: string): Promise<number>;
  deleteAccountData?(tradingAccountId: string): Promise<void>;
}
