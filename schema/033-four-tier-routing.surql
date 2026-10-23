-- Canonical four tiers; legacy values remain readable during rolling upgrades.
DEFINE FIELD OVERWRITE model_tier ON task TYPE option<string> ASSERT $value = NONE OR $value IN ['fable', 'opus', 'sonnet', 'haiku', 'high', 'medium', 'low'];

-- Reopening invalidates model settlement; a later acceptance evaluates the complete rework history again.
DEFINE EVENT IF NOT EXISTS model_evaluation_reopened ON TABLE task WHEN $before.state = 'done' AND $after.state != 'done' THEN {
  UPDATE $after.id SET evaluated_at = NONE;
  DELETE model_scorecard WHERE task = $after.id;
};
