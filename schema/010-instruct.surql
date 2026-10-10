-- Owner free-form instruction routed to gm as a task (kind='instruct').
DEFINE FIELD OVERWRITE kind ON owner_command TYPE string
  ASSERT $value IN ['goal', 'approve', 'reject', 'reply', 'direction', 'instruct', 'pause', 'resume'];
