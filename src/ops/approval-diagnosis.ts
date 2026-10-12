/** 受控诊断：未评估项不能视为通过；禁止添加原始行或主体。 */
export const diagnosticFailureByCheck = {
  "leaseCallerMatches": "lease-caller-mismatch",
  "leaseStateEligible": "lease-state-ineligible",
  "leaseUnexpired": "lease-expired",
  "leaseEmployeeActive": "lease-employee-inactive",
  "leaseRoleEligible": "lease-role-ineligible",
  "leaseGoalProjectMatch": "lease-scope-mismatch",
  "leaseFenceDeliveryCurrent": "lease-stamp-changed",
  "manifestRootMatches": "manifest-root-mismatch",
  "documentRootMatches": "document-root-mismatch",
  "fileSafetyValid": "file-unsafe-or-unavailable",
  "manifestSchemaValid": "manifest-schema-invalid",
  "documentSchemaValid": "document-schema-invalid",
  "configurationDigestValid": "configuration-digest-invalid",
  "documentHashValid": "document-hash-invalid",
  "serviceFieldsMatch": "service-binding-mismatch",
  "activityIdMatches": "activity-mismatch",
  "sampleNotFuture": "evidence-sampled-in-future",
  "evidenceUnexpired": "evidence-expired",
  "serviceEvidenceEligible": "service-evidence-ineligible",
  "candidateExists": "candidate-missing",
  "candidateEnvMatches": "candidate-env-mismatch",
  "candidateDigestMatches": "candidate-digest-mismatch",
  "candidateManifestHashMatches": "candidate-manifest-hash-mismatch",
  "candidateDocumentHashMatches": "candidate-document-hash-mismatch",
  "candidateManifestResolvedPathMatches": "candidate-manifest-path-mismatch",
  "candidateDocumentResolvedPathMatches": "candidate-document-path-mismatch",
  "approvalTaskExists": "approval-task-missing",
  "approvalTaskDone": "approval-task-not-done",
  "approvalTaskKindEligible": "approval-task-kind-ineligible",
  "approvalTaskGoalMatches": "approval-task-goal-mismatch",
  "approvalTaskProjectMatches": "approval-task-project-mismatch",
  "candidateAuthorMatchesSubmitter": "candidate-author-mismatch",
  "approvalAuditExists": "approval-audit-missing",
  "auditVersionMatchesTask": "audit-version-mismatch",
  "auditMarkerExactLine": "audit-marker-missing",
  "auditActorIsRecordId": "audit-actor-not-record-id",
  "auditActorMatchesAcceptedBy": "audit-actor-mismatch",
  "reviewerIndependent": "self-review",
  "reviewerExists": "reviewer-missing",
  "reviewerNotRevoked": "reviewer-revoked",
  "reviewerNotRetired": "reviewer-retired",
  "ownerAcceptedByMatches": "owner-accepted-by-mismatch",
  "ownerReviewerRoleMatches": "owner-reviewer-role-mismatch",
  "leaseStillCurrent": "lease-changed-during-diagnosis",
  "approvalSnapshotStable": "approval-changed-during-diagnosis"
} as const;
export type DiagnosticCheck = keyof typeof diagnosticFailureByCheck;
export type DiagnosticFailure = typeof diagnosticFailureByCheck[DiagnosticCheck];
export type CheckResult = Readonly<{ evaluated: boolean; matched: boolean }>;
export type ApprovalDiagnosis =
  | Readonly<{ outcome: "denied"; failure: "scope-denied" }>
  | Readonly<{
      outcome: "evaluated";
      failure: DiagnosticFailure | "none" | "dependency-unavailable" | "snapshot-unstable";
      snapshotStable: boolean;
      allApplicableChecksMatch: boolean;
      checks: Readonly<Record<DiagnosticCheck, CheckResult>>;
    }>;

export const emptyChecks = (): Record<DiagnosticCheck, CheckResult> => Object.fromEntries(
  Object.keys(diagnosticFailureByCheck).map(key => [key, { evaluated: false, matched: false }])
) as Record<DiagnosticCheck, CheckResult>;
export function mark(checks: Record<DiagnosticCheck, CheckResult>, key: DiagnosticCheck, matched: boolean): void {
  checks[key] = { evaluated: true, matched };
}
export function diagnosis(checks: Record<DiagnosticCheck, CheckResult>, snapshotStable: boolean, dependencyUnavailable = false): ApprovalDiagnosis {
  const failure = (Object.keys(diagnosticFailureByCheck) as DiagnosticCheck[]).find(key => checks[key].evaluated && !checks[key].matched);
  return { outcome: 'evaluated', checks, snapshotStable,
    allApplicableChecksMatch: !dependencyUnavailable && snapshotStable && !failure,
    failure: dependencyUnavailable ? 'dependency-unavailable' : !snapshotStable ? 'snapshot-unstable' : failure ? diagnosticFailureByCheck[failure] : 'none' };
}
