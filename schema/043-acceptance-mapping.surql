-- SYS-INT: versioned acceptance-mapping import marker. Only new optional fields on task; a rollback to a release
-- without this schema ignores them, and an imported row falls back to the legacy path there (never misdispatched).
DEFINE FIELD IF NOT EXISTS acceptance_mapping_at ON task TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS acceptance_mapping_digest ON task TYPE option<string>;
