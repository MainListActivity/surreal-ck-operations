-- v15: controlled screenplay revision edges (受控剧本修订边).
-- A legal revision draft carries `revises` -> its direct predecessor; the service atomically
-- voids the predecessor, stamps `superseded_by` on it, and gives both drafts the same `lineage`
-- root plus a 1-based `revision_no`. Dependency evaluation then resolves any version in the
-- chain to the chain tip (superseded_by = NONE) via `lineage` — O(1), no traversal.
-- Additive only: every field is optional; no existing row is rewritten or deleted.

DEFINE FIELD IF NOT EXISTS revises ON task TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS superseded_by ON task TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS lineage ON task TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS revision_no ON task TYPE option<int>;
DEFINE INDEX IF NOT EXISTS task_lineage ON task FIELDS lineage;
