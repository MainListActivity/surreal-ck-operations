-- Remote-magpie approval candidates (FV06 window binding). Additive fields on the existing
-- internal_ai_candidate row so a remote candidate is distinguishable from the v2 manifest chain.
-- The row shape the resume checks read (digest, evidence_expires_at, author, env) is unchanged.
DEFINE FIELD IF NOT EXISTS type ON internal_ai_candidate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source_path ON internal_ai_candidate TYPE option<string>;
