import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { AuditEntry, Brief, Inbox, PermissionRequest, Roster, TaskView } from "./types";

const record = <T>() => z.custom<T>(value => typeof value === "object" && value !== null);
const key = z.string().min(1);

export const inbox = defineRpc({
  name: "company.inbox",
  input: z.object({}),
  output: record<Inbox>(),
});

export const brief = defineRpc({
  name: "company.brief",
  input: z.object({}),
  output: record<Brief>(),
});

export const createGoal = defineRpc({
  name: "company.goal.create",
  input: z.object({
    text: z.string().min(2),
    tier: z.enum(["quick", "standard", "program"]).optional(),
    project: z.string().optional(),
    key,
  }),
  output: z.object({ id: z.string(), state: z.string() }),
});

export const triageGoal = defineRpc({
  name: "company.goal.triage",
  input: z.object({ goalId: z.string().min(1), tier: z.enum(["quick", "standard", "program"]) }),
  output: z.object({ id: z.string(), state: z.string(), tier: z.string().optional() }),
});

export const addDirection = defineRpc({
  name: "company.direction.add",
  input: z.object({ text: z.string().min(2), key }),
  output: z.object({ ok: z.boolean() }),
});

export const decide = defineRpc({
  name: "company.decide",
  input: z.object({
    taskId: z.string().min(1),
    decision: z.enum(["approve", "reject", "reply"]),
    note: z.string().default(""),
    key,
  }),
  output: z.object({ state: z.string() }),
});

export const resolveNotice = defineRpc({
  name: "company.notice.resolve",
  input: z.object({ key }),
  output: z.object({ ok: z.boolean() }),
});

export const setPaused = defineRpc({
  name: "company.pause.set",
  input: z.object({ paused: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});

export const goalTasks = defineRpc({
  name: "company.goal.tasks",
  input: z.object({ goalId: z.string().min(1) }),
  output: z.object({ tasks: z.array(record<TaskView>()) }),
});

export const taskDetail = defineRpc({
  name: "company.task.detail",
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({ task: record<TaskView>(), audit: z.array(record<AuditEntry>()) }),
});

export const roster = defineRpc({
  name: "company.roster",
  input: z.object({}),
  output: record<Roster>(),
});

export const pendingPermissions = defineRpc({
  name: "company.permissions",
  input: z.object({}),
  output: z.object({ items: z.array(record<PermissionRequest>()) }),
});

export const answerPermission = defineRpc({
  name: "company.permission.answer",
  input: z.object({
    agentId: z.string().min(1),
    requestId: z.string().min(1),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});
