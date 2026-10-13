import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { AuditEntry, Brief, Inbox, PermissionRequest, ProviderOptionsResult, Pulse, Roster, TaskAttachment, TaskView } from "./types";

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

export const pulse = defineRpc({
  name: "company.pulse",
  input: z.object({}),
  output: record<Pulse>(),
});

export const createGoal = defineRpc({
  name: "company.goal.create",
  input: z.object({
    text: z.string().min(2),
    tier: z.enum(["quick", "standard", "program"]).optional(),
    project: z.string().optional(),
    pipeline: z.enum(["software", "video", "story"]).optional(),
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

export const taskAttachments = defineRpc({
  name: "company.task.attachments",
  input: z.object({ taskId: z.string().min(1).max(128) }),
  output: z.object({ attachments: z.array(record<TaskAttachment>()) }),
});

export const openAttachment = defineRpc({
  name: "company.attachments.open",
  input: z.object({ taskId: z.string().min(1).max(128), name: z.string().min(1).max(512) }),
  output: z.object({ ok: z.boolean() }),
});

export const attachmentUrl = defineRpc({
  name: "company.attachments.url",
  input: z.object({ taskId: z.string().min(1).max(128), name: z.string().min(1).max(512) }),
  // LAN URL 无时效，expiresAt 仅在签名 URL 形态下存在（保留字段兼容旧客户端）。
  output: z.object({ url: z.string(), expiresAt: z.string().optional() }),
});

export const openExternal = defineRpc({
  name: "company.shell.open-external",
  input: z.object({ url: z.string().min(1).max(2048) }),
  output: z.object({ ok: z.boolean() }),
});

export const consoleUrl = defineRpc({
  name: "company.console.url",
  input: z.object({}),
  output: z.object({ url: z.string() }),
});

export const readAttachment = defineRpc({
  name: "company.attachments.read",
  input: z.object({ taskId: z.string().min(1).max(128), name: z.string().min(1).max(512) }),
  output: z.object({ dataUri: z.string(), mime: z.string(), sizeBytes: z.number() }),
});

export const roster = defineRpc({
  name: "company.roster",
  input: z.object({}),
  output: record<Roster>(),
});

export const providerOptions = defineRpc({
  name: "company.provider.options",
  input: z.object({}),
  output: record<ProviderOptionsResult>(),
});

export const registerDef = defineRpc({
  name: "company.def.register",
  input: z.object({
    role: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    thinking: z.string().optional(),
    maxInstances: z.number().int().min(1).optional(),
    weight: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
  }),
  output: z.object({ id: z.string() }),
});

export const setDefEnabled = defineRpc({
  name: "company.def.enabled",
  input: z.object({ defId: z.string().min(1), enabled: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
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
