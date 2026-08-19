import type { CreateRealExecutionProposalInput, RealExecutionProposal, RealExecutionProposalStatus } from "../../application/execution/RealExecutionProposal.js";
import type { RealExecutionProposalRepository } from "../../application/execution/RealExecutionProposalRepository.js";

export class MemoryRealExecutionProposalRepository implements RealExecutionProposalRepository {
  private readonly proposals = new Map<string, RealExecutionProposal>();
  private readonly setupIndex = new Map<string, string>();

  async createOrGet(input: CreateRealExecutionProposalInput): Promise<{ proposal: RealExecutionProposal; created: boolean }> {
    const key = indexKey(input.tradingAccountId, input.setupKey);
    const existingId = this.setupIndex.get(key);
    if (existingId) return { proposal: clone(this.proposals.get(existingId) as RealExecutionProposal), created: false };
    const proposal: RealExecutionProposal = {
      ...input,
      createdAt: new Date().toISOString(),
      approvedAt: null,
      approvedByUserId: null,
      executedAt: null,
      rejectedAt: null,
      cancelledAt: null,
      executionIntentId: null
    };
    this.proposals.set(proposal.id, proposal);
    this.setupIndex.set(key, proposal.id);
    return { proposal: clone(proposal), created: true };
  }

  async findById(tradingAccountId: string, proposalId: string): Promise<RealExecutionProposal | null> {
    const proposal = this.proposals.get(proposalId);
    return proposal?.tradingAccountId === tradingAccountId ? clone(proposal) : null;
  }

  async findBySetupKey(tradingAccountId: string, setupKey: string): Promise<RealExecutionProposal | null> {
    const id = this.setupIndex.get(indexKey(tradingAccountId, setupKey));
    const proposal = id ? this.proposals.get(id) : null;
    return proposal ? clone(proposal) : null;
  }

  async listByAccount(tradingAccountId: string, limit = 100): Promise<RealExecutionProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.tradingAccountId === tradingAccountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async transitionStatus(
    tradingAccountId: string,
    proposalId: string,
    expected: RealExecutionProposalStatus[],
    next: RealExecutionProposalStatus,
    patch: Partial<RealExecutionProposal> = {}
  ): Promise<RealExecutionProposal | null> {
    const current = this.proposals.get(proposalId);
    if (!current || current.tradingAccountId !== tradingAccountId || !expected.includes(current.status)) return null;
    const updated = { ...current, ...patch, id: current.id, tradingAccountId, setupKey: current.setupKey, status: next };
    this.proposals.set(proposalId, updated);
    return clone(updated);
  }

  async expireOpen(nowIso: string): Promise<number> {
    let count = 0;
    for (const proposal of this.proposals.values()) {
      if (proposal.status === "PENDING" && proposal.expiresAt <= nowIso) {
        this.proposals.set(proposal.id, { ...proposal, status: "EXPIRED" });
        count += 1;
      }
    }
    return count;
  }

  async deleteAccountData(tradingAccountId: string): Promise<void> {
    for (const proposal of this.proposals.values()) {
      if (proposal.tradingAccountId !== tradingAccountId) continue;
      this.proposals.delete(proposal.id);
      this.setupIndex.delete(indexKey(proposal.tradingAccountId, proposal.setupKey));
    }
  }
}

function indexKey(tradingAccountId: string, setupKey: string): string {
  return `${tradingAccountId}:${setupKey}`;
}

function clone(proposal: RealExecutionProposal): RealExecutionProposal {
  return {
    ...proposal,
    strategySnapshot: { ...proposal.strategySnapshot },
    riskSnapshot: { ...proposal.riskSnapshot }
  };
}
