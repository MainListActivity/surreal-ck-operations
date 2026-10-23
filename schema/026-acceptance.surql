-- SYS02: versioned structured acceptance criteria and server-verified acceptance evidence.
-- task is SCHEMALESS; these fields are additive and optional, so rows written by releases before SYS02 stay valid.
DEFINE FIELD IF NOT EXISTS acceptance_criteria ON task TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS acceptance_version ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS acceptance_legacy ON task TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS acceptance_head ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS acceptance_environment ON task TYPE option<string>;
DEFINE FIELD IF NOT EXISTS acceptance_attempt ON task TYPE option<int>;
DEFINE FIELD IF NOT EXISTS acceptance_chain ON task TYPE option<string>;

DEFINE TABLE IF NOT EXISTS acceptance_evidence SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS task ON acceptance_evidence TYPE record<task>;
DEFINE FIELD IF NOT EXISTS ac_id ON acceptance_evidence TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS kind ON acceptance_evidence TYPE string ASSERT $value IN ['machine', 'human'];
DEFINE FIELD IF NOT EXISTS sha ON acceptance_evidence TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS environment ON acceptance_evidence TYPE option<string>;
DEFINE FIELD IF NOT EXISTS attempt ON acceptance_evidence TYPE option<int>;
DEFINE FIELD IF NOT EXISTS evidence_type ON acceptance_evidence TYPE string ASSERT $value IN ['ci-run', 'probe', 'artifact', 'review-signoff'];
DEFINE FIELD IF NOT EXISTS source ON acceptance_evidence TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS verified ON acceptance_evidence TYPE bool;
DEFINE FIELD IF NOT EXISTS verifier ON acceptance_evidence TYPE string;
DEFINE FIELD IF NOT EXISTS actor ON acceptance_evidence TYPE string;
DEFINE FIELD IF NOT EXISTS at ON acceptance_evidence TYPE datetime;
DEFINE FIELD IF NOT EXISTS criteria_version ON acceptance_evidence TYPE int;
DEFINE FIELD IF NOT EXISTS task_version ON acceptance_evidence TYPE int;
DEFINE FIELD IF NOT EXISTS digest ON acceptance_evidence TYPE string;
DEFINE INDEX IF NOT EXISTS acceptance_evidence_digest ON acceptance_evidence FIELDS digest UNIQUE;
DEFINE INDEX IF NOT EXISTS acceptance_evidence_task ON acceptance_evidence FIELDS task, ac_id, sha;
