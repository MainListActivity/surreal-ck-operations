import type { OwnerDesk } from '../owner.ts';
import type { CompanyConfig, EmployeeDef, EmployeeInst, ProviderHealth, SupervisedTask, Workforce } from '../workforce.ts';
import { effectiveWeight, weightedOrder } from '../workforce.ts';
import { UNATTENDED_MODE, type PaseoGateway } from './paseo.ts';
import { evalPrompt, gmAttention, wake, type PromptEnv } from './prompts.ts';
import { jevEvalQuestions, parseJevEval, type JevClient, type JevScoreAnswers } from './jev.ts';

/** Provider error text that means the subscription is out of budget or rate limited, not that the session is broken. */
export const EXHAUSTED_PATTERN = /out of credits|add credits|credit balance|quota|usage limit|rate.?limit|too many requests|\b429\b|limit reached|insufficient|billing|exceeded your|try again (in|later)/i;
const LEASE_SECONDS = 600;
const LOG_TAIL_ENTRIES = 60;

type InstState = 'busy' | 'idle' | 'down' | 'exhausted';

export interface DispatcherDeps {
  workforce: Workforce;
  owner: OwnerDesk;
  paseo: PaseoGateway;
  env: PromptEnv;
  notify?: (title: string, text: string) => Promise<void>;
  log?: (message: string) => void;
  /** Randomness source for weighted picks; injectable for tests. */
  rand?: () => number;
  /** Jev System One decision model; undefined disables the Jev evaluation path. */
  jev?: JevClient;
}

export interface TickReport {
  commands: number;
  revoked: string[];
  extended: string[];
  woke: Array<{ task: string; employee: string; spawned: boolean }>;
  retired: string[];
  exhausted: string[];
  notices: string[];
  evals: string[];
  skipped?: 'paused' | 'budget';
}

export class Dispatcher {
  /** Last observed Paseo status per agent; a busy→idle transition is the recovery signal for a provider. */
  private readonly lastStatus = new Map<string, string>();
  private readonly onboarded = new Set<string>();

  constructor(private readonly deps: DispatcherDeps) {}
  private log(message: string) { this.deps.log?.(message); }

  async tick(): Promise<TickReport> {
    const { workforce: wf, owner, paseo } = this.deps;
    const report: TickReport = { commands: 0, revoked: [], extended: [], woke: [], retired: [], exhausted: [], notices: [], evals: [] };
    report.commands = (await owner.applyPending()).length;
    const cfg = await wf.config();
    const [agents, defs, now] = await Promise.all([paseo.list(), wf.defs(), wf.serverNow()]);
    let insts = await wf.insts();
    let health = await wf.providerHealth();

    // 1. Session health.
    const states = new Map<string, InstState>();
    for (const inst of insts) {
      if (!inst.paseoAgentId) {
        await wf.retire(inst.id, 'spawn did not bind a Paseo agent');
        report.retired.push(inst.id);
        continue;
      }
      const status = agents.get(inst.paseoAgentId)?.status ?? (await paseo.status(inst.paseoAgentId))?.status ?? 'missing';
      const previous = this.lastStatus.get(inst.paseoAgentId);
      this.lastStatus.set(inst.paseoAgentId, status);
      if (status === 'running' || status === 'initializing') { states.set(inst.id, 'busy'); continue; }
      if (status === 'idle') {
        states.set(inst.id, 'idle');
        if ((previous === 'running' || previous === 'error') && inst.provider) {
          if (health.get(inst.provider)?.state === 'exhausted') await wf.markHealthy(inst.provider);
          if (inst.def) await wf.defHealthy(inst.def);
        }
        continue;
      }
      if (status === 'error') {
        const error = await paseo.lastError(inst.paseoAgentId);
        if (EXHAUSTED_PATTERN.test(error) && inst.provider) {
          states.set(inst.id, 'exhausted');
          // Only a fresh failure (a turn that ran into the limit) restarts the cooldown; a session that is
          // still sitting in the old error state must not keep doubling it, or the provider is never probed.
          const known = health.get(inst.provider)?.state === 'exhausted';
          const fresh = previous === undefined ? !known : previous !== 'error';
          if (fresh && !report.exhausted.includes(inst.provider)) {
            await wf.markExhausted(inst.provider, error);
            report.exhausted.push(inst.provider);
          }
          continue;
        }
        states.set(inst.id, 'down');
        await this.retireBroken(inst, `session error: ${error.slice(0, 200) || 'unknown'}`, defs, report);
        continue;
      }
      states.set(inst.id, 'down');
      await this.retireBroken(inst, `session ${status}`, defs, report, false);
    }
    health = await wf.providerHealth();
    const byId = new Map(insts.map(i => [i.id, i]));

    // 2. Lease supervision: extend live holders, revoke dead or stalled ones with a handover packet.
    for (const task of await wf.tasks()) {
      if (!task.currentEmployee) continue;
      const inst = byId.get(task.currentEmployee);
      const state = inst ? states.get(inst.id) : undefined;
      const expired = (task.leaseExpiresAt ?? 0) <= now;
      if (state === 'busy') {
        if (task.progressAt && now - task.progressAt > cfg.stallMinutes * 60) {
          await paseo.stop(inst!.paseoAgentId!).catch(() => undefined);
          await this.revoke(task, `员工 ${inst!.id} 超过 ${cfg.stallMinutes} 分钟没有任何 checkpoint，已中止其会话`, inst, report);
        } else if ((task.leaseExpiresAt ?? 0) - now < cfg.extendWithinSeconds &&
          await wf.extendLease(task.id, task.currentEmployee, LEASE_SECONDS)) {
          report.extended.push(task.id);
        }
        continue;
      }
      if (state === 'down' || state === 'exhausted') {
        await this.revoke(task, `员工 ${inst!.id} 的会话${state === 'exhausted' ? '所在订阅额度耗尽/限流' : '已中断'}`, inst, report);
      } else if (expired) {
        await this.revoke(task, `员工 ${task.currentEmployee} 结束本轮但未交接，租约已过期`, inst, report);
      }
    }
    insts = insts.filter(i => !report.retired.includes(i.id));
    const tasks = await wf.tasks();

    // 3. Owner inbox notices (gates, questions) and staffing gaps.
    await this.ownerNotices(tasks, report);

    // 4. Work that needs an employee.
    const holding = new Set(tasks.filter(t => t.currentEmployee).map(t => t.currentEmployee!));
    const work = [
      ...tasks.filter(t => t.state === 'review' && t.reviewerRole !== 'owner' && !t.currentEmployee)
        .map(t => ({ task: t, role: t.reviewerRole, purpose: 'review' })),
      ...tasks.filter(t => t.state === 'ready' && !t.currentEmployee)
        .map(t => ({ task: t, role: t.executorRole as string, purpose: 'execute' })),
    ];
    const gmBlocked = tasks.filter(t => t.state === 'blocked' && t.blockedTo === 'gm');
    const usable = [...new Set(defs.filter(d => d.enabled).map(d => d.provider))]
      .filter(p => this.available(health.get(p), now) !== 'down');
    if ((work.length || gmBlocked.length) && usable.length === 0) {
      const text = `所有订阅都已耗尽或限流，公司暂停派工。请为以下订阅充值或等待额度恢复：${
        [...health.values()].filter(h => h.state === 'exhausted').map(h => `${h.provider}（预计 ${new Date((h.until ?? now) * 1000).toLocaleString('zh-CN')} 后重试）`).join('、') || '全部'}`;
      await this.notice('budget', text, report);
      report.skipped = 'budget';
      return report;
    }
    await owner.resolveNotice('budget');
    if (cfg.paused) { report.skipped = 'paused'; return report; }

    const busyBy = new Map<string, number>();
    let running = 0;
    for (const inst of insts) {
      if (states.get(inst.id) !== 'busy') continue;
      running++;
      busyBy.set(inst.provider ?? '', (busyBy.get(inst.provider ?? '') ?? 0) + 1);
    }
    const assigned = new Set<string>();
    const rand = this.deps.rand ?? Math.random;
    const pick = (role: string, task?: SupervisedTask, avoid?: string) => {
      const ready = (inst: EmployeeInst) => states.get(inst.id) === 'idle' ||
        (states.get(inst.id) === 'exhausted' && this.available(health.get(inst.provider ?? ''), now) === 'probe');
      const ok = (inst: EmployeeInst) => inst.role === role && ready(inst) && !assigned.has(inst.id) &&
        !holding.has(inst.id) && inst.id !== task?.submittedBy && this.capacity(inst.provider ?? '', cfg, health, busyBy, now);
      const candidates = insts.filter(ok);
      const weight = (inst: EmployeeInst) => effectiveWeight(defs.find(d => d.id === inst.def));
      // Continuity beats weights: the previous holder keeps the task when it is still available.
      const previous = candidates.find(i => i.id === task?.previousEmployee);
      if (previous) return previous;
      const pool = candidates.filter(i => i.id !== avoid);
      return weightedOrder(pool.length ? pool : candidates, weight, rand)[0];
    };
    const spawnable = (role: string) => weightedOrder(
      defs.filter(d => d.enabled && d.role === role &&
        insts.filter(i => i.def === d.id).length < d.maxInstances && this.capacity(d.provider, cfg, health, busyBy, now)),
      effectiveWeight, rand);

    for (const item of work) {
      if (running >= cfg.maxRunning) break;
      const last = await wf.lastDispatch(item.task.id, item.task.version, item.purpose);
      if (last && now - last.at < cfg.redispatchMinutes * 60) continue;
      const result = await this.assign(item.role, item.task, last?.employee, pick, spawnable,
        (inst, first) => wake(inst, item.task, this.deps.env, first), report, insts);
      if (!result) {
        await this.notice(`staff:${item.role}`, `岗位 ${item.role} 当前没有可用员工（无空闲实例且无法新开：定义缺失、已停用、达到上限或订阅不可用），任务 ${item.task.id} 等待中。`, report);
        continue;
      }
      await owner.resolveNotice(`staff:${item.role}`);
      await wf.recordDispatch(item.task.id, item.task.version, item.purpose, result.id);
      running++;
      busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
      assigned.add(result.id);
      report.woke.push({ task: item.task.id, employee: result.id, spawned: result.spawned });
    }

    const pendingGm: SupervisedTask[] = [];
    for (const task of gmBlocked) {
      const last = await wf.lastDispatch(task.id, task.version, 'gm-attention');
      if (!last || now - last.at >= cfg.redispatchMinutes * 60) pendingGm.push(task);
    }
    if (pendingGm.length && running < cfg.maxRunning) {
      const result = await this.assign('gm', undefined, undefined, pick, spawnable,
        (inst, first) => gmAttention(inst, pendingGm, this.deps.env, first), report, insts);
      if (result) {
        for (const task of pendingGm) await wf.recordDispatch(task.id, task.version, 'gm-attention', result.id);
        report.woke.push(...pendingGm.map(t => ({ task: t.id, employee: result.id, spawned: result.spawned })));
      }
    }

    // 5. Performance evaluation. Jev (System One decision model) scores the finished task in
    //    one ~500ms round trip; low-confidence or repeated failures escalate to an LLM eval
    //    employee, which stays the only path when Jev is not configured.
    if (cfg.evalEnabled) {
      const jevReady = this.deps.jev !== undefined && cfg.evalEngine !== 'llm';
      const llmReady = cfg.evalEngine !== 'jev' && defs.some(d => d.role === 'eval' && d.enabled);
      for (const task of await wf.pendingEvaluations(3)) {
        // A recent eval dispatch (LLM or Jev in flight) pauses both engines for this task.
        const last = await wf.lastDispatch(task.id, task.version, 'eval');
        const dispatched = last && now - last.at < cfg.redispatchMinutes * 60;
        if (!dispatched && jevReady && task.evalAttempts < 3) {
          const outcome = await this.jevEvaluate(task, cfg, report);
          if (outcome === 'done') { report.evals.push(task.id); continue; }
          if (outcome === 'retry') continue;
        }
        if (!llmReady) {
          if (cfg.evalEngine === 'jev' || task.evalAttempts >= 3) {
            await this.notice(`eval-stuck:${task.id}`,
              `任务 ${task.id} 的绩效评审无法完成：${cfg.evalEngine === 'jev' ? 'eval_engine=jev 且 Jev 连续失败' : 'Jev 不可用/连续失败且没有启用的 eval 员工定义'}。检查 JEV_API_KEY 或改用 eval_engine=llm。`, report);
          }
          continue;
        }
        if (running >= cfg.maxRunning || dispatched) continue;
        const result = await this.assign('eval', undefined, last?.employee, pick, spawnable,
          (inst, first) => evalPrompt(inst, task, this.deps.env, first), report, insts);
        if (result) {
          await wf.recordDispatch(task.id, task.version, 'eval', result.id);
          running++;
          busyBy.set(result.provider ?? '', (busyBy.get(result.provider ?? '') ?? 0) + 1);
          assigned.add(result.id);
          report.evals.push(task.id);
          report.woke.push({ task: task.id, employee: result.id, spawned: result.spawned });
        }
      }
    }
    return report;
  }

  /**
   * One Jev round trip scores every participant of a finished task.
   * Returns 'done' when scorecards were written, 'retry' to try again next tick,
   * 'escalate' to hand the task to the LLM eval role.
   */
  private async jevEvaluate(task: SupervisedTask, cfg: CompanyConfig, report: TickReport): Promise<'done' | 'retry' | 'escalate'> {
    const { workforce: wf, jev } = this.deps;
    if (!jev) return 'escalate';
    const attempts = await wf.bumpEvalAttempt(task.id);
    let parsed: JevScoreAnswers;
    try {
      const state = await wf.evalState(task.id);
      const questions = jevEvalQuestions(state.participants);
      const result = Object.keys(questions).length
        ? await jev.ask({
          task: { id: task.id, title: state.title, context: state.context, executorRole: state.executorRole, reviewerRole: state.reviewerRole },
          participants: state.participants,
          metrics: state.metrics,
          timeline: state.timeline,
        }, questions)
        : { model: jev.model, answers: {} };
      parsed = parseJevEval(state.participants, result.answers, cfg.jevFlagThreshold);
      if (state.participants.length === 0 || parsed.minConfidence >= cfg.jevMinConfidence || cfg.evalEngine === 'jev') {
        const summary = `Jev 评审（${result.model}）：${parsed.topPerformer ? `本轮最佳 ${parsed.topPerformer}；` : ''}` +
          `${parsed.scores.map(s => `${s.employee} 综合 ${s.overall.toFixed(1)} 置信 ${s.confidence.toFixed(2)}`).join('；') || '无参与者'}`;
        await wf.recordJevEvaluation(task.id, result.model, summary,
          parsed.scores.map(s => ({ ...s, flagged: parsed.flagged.includes(s.employee) })), state, parsed.topPerformer);
        for (const emp of parsed.flagged) {
          await this.notice(`eval-flag:${task.id}:${emp}`,
            `Jev 评审标记：任务 ${task.id} 中员工 ${emp} 的行为需要你关注（详见 scorecard）。`, report);
        }
        this.log(`jev evaluated ${task.id}: ${parsed.scores.length} scorecards, min confidence ${parsed.minConfidence.toFixed(2)}`);
        return 'done';
      }
      this.log(`jev low confidence on ${task.id} (${parsed.minConfidence.toFixed(2)} < ${cfg.jevMinConfidence}); escalating to eval employee`);
      return 'escalate';
    } catch (error) {
      this.log(`jev evaluation failed for ${task.id} (attempt ${attempts}): ${(error as Error).message}`);
      return attempts >= 3 ? 'escalate' : 'retry';
    }
  }

  private available(h: ProviderHealth | undefined, now: number): 'ok' | 'probe' | 'down' {
    if (!h || h.state === 'healthy') return 'ok';
    return now >= (h.until ?? 0) ? 'probe' : 'down';
  }

  /** A recovering provider gets a single probe session until a turn completes cleanly. */
  private capacity(provider: string, cfg: CompanyConfig, health: Map<string, ProviderHealth>, busyBy: Map<string, number>, now: number): boolean {
    const availability = this.available(health.get(provider), now);
    if (availability === 'down') return false;
    const busy = busyBy.get(provider) ?? 0;
    return availability === 'probe' ? busy === 0 : busy < (cfg.providerMax[provider] ?? 1);
  }

  private async assign(
    role: string, task: SupervisedTask | undefined, avoid: string | undefined,
    pick: (role: string, task?: SupervisedTask, avoid?: string) => EmployeeInst | undefined,
    spawnable: (role: string) => EmployeeDef[],
    prompt: (inst: EmployeeInst, firstContact: boolean) => string,
    report: TickReport, insts: EmployeeInst[],
  ): Promise<(EmployeeInst & { spawned: boolean }) | undefined> {
    const { workforce: wf, paseo, env } = this.deps;
    const existing = pick(role, task, avoid);
    if (existing) {
      try {
        const first = !this.onboarded.has(existing.id) && !existing.onboarded;
        await paseo.send(existing.paseoAgentId!, prompt(existing, first));
        this.onboarded.add(existing.id);
        this.lastStatus.set(existing.paseoAgentId!, 'running');
        await wf.touchWake(existing.id);
        this.log(`woke ${existing.id} for ${task?.id ?? `dispatch:${role}`}`);
        return { ...existing, spawned: false };
      } catch (error) {
        this.log(`wake ${existing.id} failed: ${(error as Error).message}`);
        return undefined;
      }
    }
    for (const def of spawnable(role)) {
      const inst = await wf.spawnInst(def);
      try {
        const agentId = await paseo.spawn({
          title: `SCK · ${def.role} · ${inst.id}`, provider: def.provider, model: def.model, thinking: def.thinking,
          mode: UNATTENDED_MODE[def.provider], cwd: env.opsRepo,
          labels: { company: 'surreal-ck', employee_id: inst.id, role: def.role, def: def.id },
          env: { SCK_EMPLOYEE_CREDENTIAL_FILE: inst.credentialFile! },
          prompt: prompt(inst, true),
        });
        await wf.bind(inst.id, { agentId });
        const bound = { ...inst, paseoAgentId: agentId };
        insts.push(bound);
        this.onboarded.add(inst.id);
        this.lastStatus.set(agentId, 'running');
        await wf.touchWake(inst.id);
        this.log(`spawned ${inst.id} (${def.provider}/${def.model}) for ${task?.id ?? `dispatch:${role}`}`);
        return { ...bound, spawned: true };
      } catch (error) {
        this.log(`spawn ${inst.id} failed: ${(error as Error).message}`);
        await wf.retire(inst.id, `spawn failed: ${(error as Error).message.slice(0, 200)}`);
        report.retired.push(inst.id);
        await this.countDefFailure(def, report);
      }
    }
    return undefined;
  }

  private async revoke(task: SupervisedTask, reason: string, inst: EmployeeInst | undefined, report: TickReport) {
    const cfg = await this.deps.workforce.config();
    const log = inst?.paseoAgentId ? await this.deps.paseo.logsTail(inst.paseoAgentId, LOG_TAIL_ENTRIES) : '';
    const handover = [
      '【交接包】前任员工未完成交接。以下是其会话最后的活动记录（自动截取，可能不完整）。',
      '先核对任务分支/工作目录中的实际改动与已有 checkpoint，再继续；不要重复已完成且已验证的步骤。',
      log ? `\n---\n${log.slice(-cfg.handoverChars)}` : '（无可用会话日志）',
    ].join('\n');
    if (await this.deps.workforce.revokeLease(task.id, task.currentEmployee!, reason, handover)) {
      report.revoked.push(task.id);
      this.log(`revoked ${task.id} from ${task.currentEmployee}: ${reason}`);
    }
  }

  private async retireBroken(inst: EmployeeInst, reason: string, defs: EmployeeDef[], report: TickReport, countFailure = true) {
    await this.deps.workforce.retire(inst.id, reason);
    report.retired.push(inst.id);
    this.log(`retired ${inst.id}: ${reason}`);
    const def = defs.find(d => d.id === inst.def);
    if (def && countFailure) await this.countDefFailure(def, report);
  }

  private async countDefFailure(def: EmployeeDef, report: TickReport) {
    const streak = await this.deps.workforce.defFailure(def.id);
    if (streak >= 3) {
      await this.deps.workforce.disableDef(def.id, `连续 ${streak} 次会话异常`);
      await this.notice(`def:${def.id}`, `员工定义 ${def.id}（${def.provider}/${def.model}）连续 ${streak} 次启动或运行异常，已自动停用。请检查该订阅/模型后在 employee_def 中重新启用。`, report);
    }
  }

  private async ownerNotices(tasks: SupervisedTask[], report: TickReport) {
    const { owner } = this.deps;
    const live = new Set<string>();
    for (const task of tasks) {
      if (task.state === 'review' && task.reviewerRole === 'owner') {
        const key = `gate:${task.id}:${task.version}`;
        live.add(key);
        await this.notice(key, `关口待你决定：${task.title}（任务 ${task.id}）。查看：company owner inbox`, report);
      } else if (task.state === 'blocked' && task.blockedTo === 'owner') {
        const key = `question:${task.id}:${task.version}`;
        live.add(key);
        await this.notice(key, `员工需要你回答：${task.title}（任务 ${task.id}）。查看：company owner inbox`, report);
      }
    }
    for (const notice of await owner.openNotices()) {
      if (/^(gate|question):/.test(notice.key) && !live.has(notice.key)) await owner.resolveNotice(notice.key);
    }
  }

  private async notice(key: string, text: string, report: TickReport) {
    if (!(await this.deps.owner.raiseNotice(key, text))) return;
    report.notices.push(key);
    if (!this.deps.notify) return;
    // Jev triage: a calibrated noul decides whether this notice deserves an immediate
    // desktop popup; the notice always lands in the owner inbox regardless. Fail-open.
    const jev = this.deps.jev;
    if (jev) {
      try {
        const cfg = await this.deps.workforce.config();
        if (cfg.jevNotifyTriage) {
          const pending = (await this.deps.owner.openNotices()).length;
          const { answers } = await jev.ask(
            { notice: { key, text }, pendingInOwnerInbox: pending },
            { urgent: { type: 'noul', instructions: '这条公司系统提醒需要立即弹窗打扰老板吗？（充值、闸门决策、员工严重异常算紧急；常规状态汇报可等老板自己看收件箱）' } });
          const noul = answers.urgent;
          if (noul?.type === 'noul' && (noul.noul ?? 1) < 0.5) {
            this.log(`jev triaged notice ${key} as non-urgent (${noul.noul?.toFixed(2)})`);
            return;
          }
        }
      } catch { /* fail-open: still popup */ }
    }
    await this.deps.notify('Surreal CK 公司', text).catch(() => undefined);
  }
}
