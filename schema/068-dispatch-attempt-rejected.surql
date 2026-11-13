-- 068: a spawn the runtime refused before any session existed (Paseo agent.open.before refusal) is settled as
-- 'rejected'. Nothing was delivered, so the task/employee/message barriers may come off without a delivery record:
-- the message stays a draft, the execution identity is unchanged, and the caller then releases the lease normally.
-- Redefines the three barrier events from 065; everything else in them is unchanged.
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
    IF $after.dispatch_attempt != NONE OR $attempt.state NOT IN ['confirmed', 'rejected'] { THROW 'dispatch outcome uncertain: barrier is isolated'; };
  };
};
DEFINE EVENT OVERWRITE dispatch_employee_barrier ON TABLE employee
WHEN $before.dispatch_attempt != NONE AND $after.dispatch_attempt != $before.dispatch_attempt THEN {
  LET $attempt = SELECT * FROM ONLY $before.dispatch_attempt;
  IF $after.dispatch_attempt != NONE OR $attempt.state NOT IN ['confirmed', 'rejected'] {
    THROW 'dispatch outcome uncertain: employee barrier is isolated';
  };
};

-- Freeze the exact outbound payload until its atomic finalizer records delivery.
DEFINE EVENT OVERWRITE dispatch_message_barrier ON TABLE outbound_message WHEN $before.dispatch_attempt != NONE THEN {
  LET $attempt = SELECT * FROM ONLY $before.dispatch_attempt;
  -- A rejected spawn delivered nothing: the barrier comes off and the message stays exactly as it was.
  LET $rejected = $event = 'UPDATE' AND $attempt.state = 'rejected' AND $after.dispatch_attempt = NONE
    AND $after.state = $before.state AND $after.body = $before.body AND $after.translated_text = $before.translated_text
    AND $after.sent_to = $before.sent_to AND $after.sent_body = $before.sent_body AND $after.task = $before.task AND $after.step = $before.step;
  IF !$rejected AND ($event = 'DELETE' OR $attempt.state != 'confirmed' OR $after.dispatch_attempt != NONE
    OR $after.state != 'sent' OR $after.sent_to != $attempt.employee OR $after.sent_body != $before.dispatch_body
    OR $after.body != $before.body OR $after.translated_text != $before.translated_text) {
    THROW 'dispatch outcome uncertain: outbound payload is isolated';
  };
};
