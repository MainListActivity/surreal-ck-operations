/** Shared atomic finalization body; callers supply a transaction and attempt/agent bindings. */
export const dispatchFinalizationSql = `
      LET $a = SELECT * FROM ONLY $attempt;
      IF $a = NONE OR $a.state != 'pending' OR $a.agent != $agent OR ($a.revision != 1 AND $a.result_confirmed != true) { THROW 'dispatch completion conflict' };
      IF $a.activationRequired = true AND $a.activation_state != 'activated' AND $a.result_confirmed != true { THROW 'dispatch activation uncertain' };
      LET $task = type::record('task', $a.task);
      LET $employee = type::record('employee', $a.employee);
      LET $message = type::record('outbound_message', $a.message);
      LET $t = SELECT * FROM ONLY $task;
      LET $e = SELECT * FROM ONLY $employee;
      LET $msg = SELECT * FROM ONLY $message;
      IF $t.dispatch_attempt != $attempt OR $e.dispatch_attempt != $attempt OR $msg.dispatch_attempt != $attempt OR $e.retired = true OR $e.revoked = true { THROW 'dispatch finalization generation changed' };
      IF $e.paseo_agent_id != NONE AND $e.paseo_agent_id != $agent { THROW 'dispatch agent changed' };
      IF $t.fence != $a.fence { THROW 'dispatch fence changed' };
      IF $a.result_confirmed = true {
        LET $audit = SELECT * FROM ONLY $a.result_audit;
        IF $audit = NONE OR $audit.task != $task OR $audit.actor != $employee OR $audit.action != $a.result_action
          OR $audit.version != $a.result_version + 1 OR $t.version != $audit.version { THROW 'dispatch result evidence changed' };
      } ELSE {
        IF $t.current_employee != $a.employee OR $t.delivery_id != $a.delivery { THROW 'dispatch lease changed' };
        UPDATE ONLY $task SET lease_expires_at = math::max([$t.lease_expires_at ?? 0, time::unix(time::now()) + 600]);
      };
      IF $msg = NONE OR crypto::sha256($msg.dispatch_body) != $a.bodyHash { THROW 'dispatch body changed' };
      UPDATE ONLY $attempt SET state = 'confirmed', revision += 1, confirmed_at = time::now();
      UPDATE ONLY $employee SET paseo_agent_id = $agent,
        workspace_cwd = $a.binding.cwd ?? workspace_cwd, workspace_repo = $a.binding.repoHome ?? workspace_repo,
        workspace_scope = $a.binding.workspaceScope ?? workspace_scope, paseo_workspace = $a.binding.paseoWorkspace ?? paseo_workspace,
        model = $a.binding.model ?? model, last_wake_at = time::unix(time::now()), idle_since = NONE,
        runtime_sleep_requested_at = NONE, v3_onboarded = true, wake_count = (wake_count ?? 0) + 1, dispatch_attempt = NONE;
      UPDATE ONLY $message SET state = 'sent', sent_body = dispatch_body, sent_to = $a.employee,
        sent_at = time::now(), hold = false, dispatch_body = NONE, dispatch_attempt = NONE;
      UPDATE ONLY $task SET dispatch_attempt = NONE;
      UPDATE owner_notice SET resolved_at = time::now() WHERE key = string::concat('message-hold:', $a.task, ':', $msg.step) AND resolved_at = NONE;
      `;
