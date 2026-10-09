-- Additive control-plane records. No business data or plaintext signing keys.
DEFINE TABLE IF NOT EXISTS internal_ai_candidate SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS internal_ai_candidate_task ON internal_ai_candidate FIELDS task UNIQUE;
DEFINE FIELD IF NOT EXISTS digest ON internal_ai_candidate TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS manifest_hash ON internal_ai_candidate TYPE string READONLY;
DEFINE FIELD IF NOT EXISTS document_hash ON internal_ai_candidate TYPE string READONLY;
DEFINE TABLE IF NOT EXISTS internal_ai_proof SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS internal_ai_proof_request ON internal_ai_proof FIELDS task, delivery, fence, request_key UNIQUE;
DEFINE INDEX IF NOT EXISTS internal_ai_proof_status ON internal_ai_proof FIELDS status_hash UNIQUE;
DEFINE FIELD IF NOT EXISTS revoked ON internal_ai_proof TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS version ON internal_ai_proof TYPE int DEFAULT 1;
