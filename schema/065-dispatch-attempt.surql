-- Write-ahead evidence only; no prompt, credential or customer content.
DEFINE TABLE OVERWRITE dispatch_attempt SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX OVERWRITE dispatch_attempt_state ON dispatch_attempt FIELDS state;
-- Protect the whole execution identity, not just fence. Owner/cascade/legacy paths
-- cannot silently void, rebind, clear the holder, or remove an unresolved barrier.
DEFINE EVENT OVERWRITE dispatch_task_fence ON TABLE task WHEN $before.dispatch_attempt != NONE THEN {
  IF $event = 'DELETE' { THROW 'dispatch outcome uncertain: cannot delete task'; };
  LET $attempt = SELECT * FROM ONLY $before.dispatch_attempt;
  LET $identity_changed = $after.fence != $before.fence
    OR $after.current_employee != $before.current_employee OR $after.delivery_id != $before.delivery_id
    OR $after.state != $before.state OR $after.project != $before.project OR $after.worktree != $before.worktree;
  LET $audit = IF $attempt.result_audit != NONE { SELECT * FROM ONLY $attempt.result_audit } ELSE { NONE };
  LET $result = $attempt.state = 'pending' AND $attempt.result_confirmed = true
    AND $audit != NONE AND $audit.task = $before.id AND $audit.actor = type::record('employee', $attempt.employee)
    AND $audit.action = $attempt.result_action AND $audit.version = $before.version + 1 AND $attempt.task = <string>record::id($before.id) AND $attempt.result_audit != NONE
    AND $attempt.employee = $before.current_employee AND $attempt.delivery = $before.delivery_id
    AND $attempt.fence = $before.fence AND $attempt.result_version = $before.version
    AND $after.fence = $before.fence AND $after.project = $before.project AND $after.worktree = $before.worktree
    AND $after.current_employee = NONE AND $after.delivery_id = NONE AND $after.dispatch_attempt = $before.dispatch_attempt
    AND $after.version = $before.version + 1
    AND (($attempt.result_action = 'submit' AND $before.state = 'doing' AND $after.state = 'review')
      OR ($attempt.result_action = 'accept' AND $before.state = 'review' AND $after.state = 'done')
      OR ($attempt.result_action = 'return' AND $before.state = 'review' AND $after.state = 'ready')
      OR ($attempt.result_action = 'block' AND $before.state IN ['doing', 'review'] AND $after.state = 'blocked'));
  IF $identity_changed AND !$result { THROW 'dispatch outcome uncertain: execution identity is isolated'; };
  IF $after.dispatch_attempt != $before.dispatch_attempt AND !$result {
    IF $after.dispatch_attempt != NONE OR $attempt.state != 'confirmed' { THROW 'dispatch outcome uncertain: barrier is isolated'; };
  };
};
DEFINE EVENT OVERWRITE dispatch_employee_retirement ON TABLE employee
WHEN $before.dispatch_attempt != NONE AND ($event = 'DELETE' OR $after.retired = true OR $after.revoked = true)
THEN { THROW 'dispatch outcome uncertain: employee is isolated'; };
DEFINE EVENT OVERWRITE dispatch_employee_barrier ON TABLE employee
WHEN $before.dispatch_attempt != NONE AND $after.dispatch_attempt != $before.dispatch_attempt THEN {
  LET $attempt = SELECT * FROM ONLY $before.dispatch_attempt;
  IF $after.dispatch_attempt != NONE OR $attempt.state != 'confirmed' {
    THROW 'dispatch outcome uncertain: employee barrier is isolated';
  };
};

-- Freeze the exact outbound payload until its atomic finalizer records delivery.
DEFINE EVENT OVERWRITE dispatch_message_barrier ON TABLE outbound_message WHEN $before.dispatch_attempt != NONE THEN {
  LET $attempt = SELECT * FROM ONLY $before.dispatch_attempt;
  IF $event = 'DELETE' OR $attempt.state != 'confirmed' OR $after.dispatch_attempt != NONE
    OR $after.state != 'sent' OR $after.sent_to != $attempt.employee OR $after.sent_body != $before.dispatch_body
    OR $after.body != $before.body OR $after.translated_text != $before.translated_text {
    THROW 'dispatch outcome uncertain: outbound payload is isolated';
  };
};

-- Operator approval is provisioned only by a separately confirmed privileged path.
-- Runtime/employee JWTs must not mint or edit approvals themselves.
DEFINE TABLE OVERWRITE dispatch_recovery_approval SCHEMALESS PERMISSIONS NONE;
DEFINE TABLE OVERWRITE dispatch_recovery_receipt SCHEMALESS PERMISSIONS NONE;
DEFINE EVENT OVERWRITE dispatch_recovery_approval_guard ON TABLE dispatch_recovery_approval WHEN $access != NONE THEN {
  IF $event != 'UPDATE' OR $before.request != $after.request OR $before.agent != $after.agent
    OR $before.fingerprint != $after.fingerprint OR $before.operation != $after.operation
    OR $before.expires_at != $after.expires_at OR $before.operator != $after.operator
    OR $before.confirmation_ref != $after.confirmation_ref OR $before.action != $after.action
    OR $before.used_by != NONE OR $after.used_by = NONE { THROW 'recovery approval requires confirmed operator'; };
  LET $receipt = SELECT * FROM ONLY $after.used_by;
  IF $receipt = NONE OR $receipt.approval != $after.id OR $receipt.request != $after.request
    OR $receipt.agent != $after.agent OR $receipt.fingerprint != $after.fingerprint { THROW 'recovery approval consumption lacks receipt'; };
};

DEFINE EVENT OVERWRITE dispatch_recovery_receipt_guard ON TABLE dispatch_recovery_receipt WHEN true THEN {
  IF $event != 'CREATE' { THROW 'recovery receipts are immutable'; };
  LET $approval = SELECT * FROM ONLY $after.approval;
  LET $attempt = SELECT * FROM ONLY type::record('dispatch_attempt', $after.request);
  IF $approval = NONE OR $approval.used_by != NONE OR $approval.expires_at <= time::now()
    OR $approval.action != 'finalize_result' OR $after.action != $approval.action
    OR $after.agent != $approval.agent OR $after.request != $approval.request OR $after.fingerprint != $approval.fingerprint
    OR $after.operator != $approval.operator OR $after.confirmation_ref != $approval.confirmation_ref
    OR <string>record::id($after.id) != $approval.operation
    OR $attempt.state != 'confirmed' OR $attempt.result_confirmed != true OR $attempt.agent != $after.agent {
    THROW 'recovery receipt identity mismatch';
  };
};
