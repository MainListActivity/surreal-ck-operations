-- SYS07 P2: goal outcomes, evidence and governance state.
--
-- Additive only. `goal` is SCHEMALESS and existing rows keep working without these optional fields; no historical
-- task, acceptance or owner decision is rewritten. New tables are not read by the previous release (RB01).
--
-- Rollback isolation (RB01):
--   goal.state = 'needs_repair'                       -> previous release knows no such state; its goal-close
--     statement only matches 'active', and its goal-bound repairs/defer refuse a non-active goal. The goal cannot
--     be silently completed on rollback; ordinary tasks may still be claimed, but only the forward release can
--     clear the repair and finish the goal. A final-gate reference repair also keeps this state until the new gate
--     is accepted and goal_finalize re-evaluates it.
--   goal.needs_repair / outcome_complete / deadline   -> previous release ignores the fields.
--   goal_outcome / goal_evidence                      -> previous release never reads these tables.
--   The final gate remains an ordinary task; no task state, dependency, lease or owner decision is rewritten by
--   this migration, so a rollback adds no new dispatch source and cannot misdispatch waiting/gated work.

DEFINE FIELD IF NOT EXISTS version ON goal TYPE option<int>;
DEFINE FIELD IF NOT EXISTS deadline ON goal TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS deadline_timezone ON goal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS needs_repair ON goal TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS needs_repair_reason ON goal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS needs_repair_at ON goal TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS outcome_complete ON goal TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS outcome_updated_at ON goal TYPE option<datetime>;

-- One structured outcome contract per goal. `required_evidence` uses the SYS07 vocabulary; `final_acceptance` and
-- `owner_final` are implied by the final gate itself and are accepted here for readable contracts.
DEFINE TABLE IF NOT EXISTS goal_outcome SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS goal ON goal_outcome TYPE record<goal>;
DEFINE FIELD IF NOT EXISTS expected ON goal_outcome TYPE string ASSERT string::len($value) >= 4;
DEFINE FIELD IF NOT EXISTS required_evidence ON goal_outcome TYPE array<string>;
DEFINE FIELD IF NOT EXISTS responsible_role ON goal_outcome TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD IF NOT EXISTS deadline ON goal_outcome TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS timezone ON goal_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS version ON goal_outcome TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS source ON goal_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS actor ON goal_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON goal_outcome TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON goal_outcome TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON goal_outcome TYPE datetime;
DEFINE INDEX IF NOT EXISTS goal_outcome_goal ON goal_outcome FIELDS goal UNIQUE;

-- Immutable outcome evidence. Customer activation/adoption can only be recorded here by an authorized human
-- receipt; the model's own claim never creates a row. `owner_final` is deliberately absent: it is derived from
-- the real owner relay decision on the final gate, never typed in as evidence.
DEFINE TABLE IF NOT EXISTS goal_evidence SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS goal ON goal_evidence TYPE record<goal>;
DEFINE FIELD IF NOT EXISTS kind ON goal_evidence TYPE string
  ASSERT $value IN ['implementation', 'release', 'deploy_qa', 'customer_activation', 'customer_adoption', 'feedback'];
DEFINE FIELD IF NOT EXISTS summary ON goal_evidence TYPE string ASSERT string::len($value) >= 4;
DEFINE FIELD IF NOT EXISTS source ON goal_evidence TYPE string ASSERT string::len($value) >= 2;
DEFINE FIELD IF NOT EXISTS confirmed_by ON goal_evidence TYPE string ASSERT string::len($value) >= 2;
DEFINE FIELD IF NOT EXISTS evidence_type ON goal_evidence TYPE string
  ASSERT $value IN ['external_receipt', 'production_record', 'manual_signoff'];
DEFINE FIELD IF NOT EXISTS task ON goal_evidence TYPE option<record<task>>;
DEFINE FIELD IF NOT EXISTS at ON goal_evidence TYPE datetime;
DEFINE FIELD IF NOT EXISTS actor ON goal_evidence TYPE string;
DEFINE FIELD IF NOT EXISTS version ON goal_evidence TYPE int ASSERT $value >= 1;
DEFINE FIELD IF NOT EXISTS digest ON goal_evidence TYPE string;
DEFINE FIELD IF NOT EXISTS created_at ON goal_evidence TYPE datetime;
DEFINE INDEX IF NOT EXISTS goal_evidence_goal ON goal_evidence FIELDS goal, kind, at;
DEFINE INDEX IF NOT EXISTS goal_evidence_digest ON goal_evidence FIELDS goal, kind, digest UNIQUE;
