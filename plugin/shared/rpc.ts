import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { ModelCatalogPage, AuditEntry, ModelRankingAttempt, ModelRankingTable, Brief, Inbox, PermissionRequest, ProviderOptionsResult, Pulse, Roster, TaskAttachment, TaskView } from "./types";

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

export const voidTask = defineRpc({
  name: "company.task.void",
  input: z.object({ taskId: z.string().min(1), note: z.string().min(2), key }),
  output: z.object({ state: z.string() }),
});

export const revokeTask = defineRpc({
  name: "company.task.revoke",
  input: z.object({ taskId: z.string().min(1), note: z.string().default("") }),
  output: z.object({ ok: z.boolean(), employee: z.string().optional() }),
});

export const unlockTask = defineRpc({
  name: "company.task.unlock",
  input: z.object({ taskId: z.string().min(1) }),
  output: z.object({ unlocked: z.array(z.string()) }),
});

export const cancelGoalRpc = defineRpc({
  name: "company.goal.cancel",
  input: z.object({ goalId: z.string().min(1), note: z.string().min(2), key }),
  output: z.object({ retired: z.number(), remaining: z.number() }),
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

export const rankingPolicySchema=z.object({bandWidth:z.number().finite().min(0).max(10),weights:z.object({pace:z.number().min(0).max(100),latency:z.number().min(0).max(100),intelligence:z.number().min(0).max(100),speed:z.number().min(0).max(100),performance:z.number().min(0).max(100),price:z.number().min(0).max(100),staleness:z.number().finite().min(0).max(100).default(20)}).strict().refine(w=>Object.entries(w).some(([key,n])=>key!=='staleness'&&n>0)),billingOverrides:z.record(z.string().min(1).max(300),z.enum(['free','included','unknown','paid'])).refine(v=>Object.keys(v).length<=1000)}).strict();
export const previewModelRanking=defineRpc({name:'company.model-ranking.preview',input:z.object({policy:rankingPolicySchema,refresh:z.boolean().default(false)}),output:z.object({tables:record<ModelRankingTable[]>(),at:z.string(),policy:rankingPolicySchema})});
export const modelRanking = defineRpc({
  name: "company.model-ranking.get",
  input: z.object({}),
  output: z.object({policy:rankingPolicySchema.optional(),rules:z.string(),refreshMinutes:z.number(),configured:z.boolean(),at:z.string().optional(),error:z.string().optional(),orders:z.record(z.string(),z.array(z.string())),tables:record<ModelRankingTable[]>().default([]),attempts:record<Record<string,ModelRankingAttempt>>().default({}),requests:z.array(z.object({tier:z.string(),at:z.string(),payload:z.record(z.string(),z.unknown())})).default([])}),
});
export const saveModelRanking = defineRpc({
  name: "company.model-ranking.save",
  input: z.object({policy:rankingPolicySchema.optional(),rules:z.string().max(8000),refreshMinutes:z.union([z.literal(2),z.literal(5),z.literal(10)]).default(5)}),
  output: z.object({ok:z.boolean()}),
});

export const pinModelRanking = defineRpc({
  name: "company.model-ranking.pin",
  input: z.object({group:z.enum(["sck-haiku","sck-sonnet","sck-opus"]),model:z.string().min(1).max(300),pinned:z.boolean()}),
  output: z.object({ok:z.boolean()}),
});

export const modelCatalog=defineRpc({name:'company.model-catalog.get',input:z.object({query:z.string().max(200).default(''),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(40)}),output:record<ModelCatalogPage>()});
export const modelMembershipInput=z.object({group:z.enum(['sck-haiku','sck-sonnet','sck-opus','sck-fable']),model:z.string().min(1).max(300),present:z.boolean(),expectedMembers:z.array(z.string().max(300)).max(100)}).strict();
export const setModelMembership=defineRpc({name:'company.model-membership.set',input:modelMembershipInput,output:z.object({ok:z.boolean()})});

export const modelIdentity = defineRpc({
  name: "company.model-identity.get",
  input: z.object({}),
  output: z.object({
    aliases:z.array(z.object({model:z.string(),slug:z.string().nullable(),by:z.enum(["jev","owner"]),confidence:z.number().optional(),suggested:z.string().optional(),aa:z.object({name:z.string(),score:z.number()}).optional()})),
    issues:z.array(z.object({group:z.string(),member:z.string(),reason:z.string()})),
    inventory:z.object({at:z.string(),grouped:z.array(z.object({model:z.string(),groups:z.array(z.string())})),
      decidedUngrouped:z.array(z.object({model:z.string(),by:z.string(),slug:z.string().nullable(),at:z.string(),reason:z.string(),present:z.boolean(),confidence:z.number().optional(),suggested:z.string().optional()})),pending:z.array(z.string())}).optional(),
  }),
});
export const setModelAlias = defineRpc({
  name: "company.model-alias.set",
  input: z.object({model:z.string().min(1).max(300),slug:z.string().min(1).max(200).nullable()}),
  output: z.object({ok:z.boolean(),synchronized:z.boolean().optional()}),
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
    quotaLimited: z.boolean().optional(),
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

export const upgrade = defineRpc({
  name:"company.upgrade",
  input:z.object({taskId:key,taskVersion:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/)}),
  output:z.object({jobId:z.string(),status:z.string()}),
});

export const autoUpgrade = defineRpc({
 name:'company.upgrade.automatic',input:z.object({enabled:z.boolean()}),
 output:z.object({enabled:z.boolean(),revision:z.number()}),
});
