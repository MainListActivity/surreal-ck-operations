-- Additive. Only freshly prepared immutable candidates provide a trusted expiry.
DEFINE FIELD IF NOT EXISTS evidence_expires_at ON internal_ai_candidate TYPE option<string> READONLY;
