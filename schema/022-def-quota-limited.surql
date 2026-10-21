-- A def may opt out of quota-based dispatch gating: even at 0% remaining it is still dispatched.
-- Absent means limited (the safe default for every existing row).
DEFINE FIELD IF NOT EXISTS quota_limited ON employee_def TYPE bool DEFAULT true;
