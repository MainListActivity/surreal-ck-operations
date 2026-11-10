-- Public, bounded runtime observations. No credentials, tool payloads or reasoning.
DEFINE TABLE OVERWRITE agent_activity SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX OVERWRITE activity_expiry ON agent_activity FIELDS expires_at;
DEFINE INDEX OVERWRITE activity_employee ON agent_activity FIELDS employee, observed_at;
DEFINE INDEX OVERWRITE runtime_execution_turn ON task FIELDS runtime_execution.agent, runtime_execution.turn;
