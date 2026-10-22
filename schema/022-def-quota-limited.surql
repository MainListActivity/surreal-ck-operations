-- A def may opt out of quota-based dispatch gating: even at 0% remaining it is still dispatched.
-- Absent means limited (the safe default for every existing row). The field is optional on purpose:
-- SurrealDB validates the whole record on UPDATE, so a non-optional bool would make every row that
-- predates this field unwritable (scoring aggregates, error counters, def edits) until it is backfilled.
DEFINE FIELD OVERWRITE quota_limited ON employee_def TYPE option<bool> DEFAULT true;
