import { configurationDigest, PROOF_GOAL, sha256, type ProofManifest } from '../../src/ops/proof-contract.ts';

/** 合成开发资料：零余额、未批准、没有价格证书；不得用于启用或真实模型调用。 */
export function disabledSenseNovaFixture() {
  const evidence = {
    schemaVersion: 1 as const, type: 'development-disabled' as const,
    accountRef: 'synthetic-existing-service', endpoint: 'https://token.sensenova.cn/v1',
    model: 'sensenova-6.8-flash-lite', priceRevision: 'synthetic-unsupported', currency: 'USD' as const,
    balanceNanoUsd: 0, sampledAt: '2026-10-09T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    autoTopupDisabled: true as const, serviceApproved: false,
  };
  const documentBytes = JSON.stringify(evidence);
  const rest: Omit<ProofManifest, 'configurationDigest'> = {
    schemaVersion: 1 as const, goalId: PROOF_GOAL, project: 'surreal_ck' as const, env: 'production' as const,
    activityId: 'synthetic-disabled-sensenova', workspaceSlug: 'sck-ui01', documentHash: sha256(documentBytes),
    service: { accountRef: evidence.accountRef, endpoint: evidence.endpoint, model: evidence.model, priceRevision: evidence.priceRevision },
    budget: { currency: 'USD' as const, totalNanoUsd: 1_000_000_000, perAttemptNanoUsd: 100_000_000, maxAttempts: 30, autoTopupDisabled: true as const },
    identities: [
      { alias: 'LCA04_REMOVABLE' as const, workspaceRole: 'admin' as const, billingRole: 'owner' as const },
      { alias: 'LCA04_MEMBER' as const, workspaceRole: 'participant' as const, billingRole: 'member' as const },
    ],
  };
  return { evidence, documentBytes, manifest: { ...rest, configurationDigest: configurationDigest(rest) } };
}
