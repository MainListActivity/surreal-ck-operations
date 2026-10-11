-- v18: production lines (产线). A goal runs one pipeline template (software / video / story);
-- a project may name its default. Additive only: optional fields, no row rewritten.

DEFINE FIELD IF NOT EXISTS pipeline ON goal TYPE option<string>;
DEFINE FIELD IF NOT EXISTS pipeline ON owner_command TYPE option<string>;
DEFINE FIELD IF NOT EXISTS pipeline ON project TYPE option<string>;
