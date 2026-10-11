-- v16: worktree lanes (并行线). A lane is one serial relay chain of a goal; every task tagged with
-- the same `work_intent.lane` shares one physical tree and one branch, whoever claims it.
-- `lane` holds "<goal id>:<lane name>". Additive only: optional field, no row rewritten.

DEFINE FIELD IF NOT EXISTS lane ON worktree TYPE option<string>;
DEFINE INDEX IF NOT EXISTS worktree_lane ON worktree FIELDS lane;
