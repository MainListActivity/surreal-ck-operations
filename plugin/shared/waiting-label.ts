/**
 * RW06 C3 / RW05: the words the owner and manager task views show for a blocked task, derived only from the waiting facts the
 * server computed (kind, restored phase, role, dependency count). Kept free of React so the exact strings can be tested, and
 * imported by the task row so the rendered line is the tested text.
 */
export interface WaitingFacts {
  kind: "manager" | "owner" | "dependency";
  resumeState: string;
  role: string;
  dependenciesCount: number;
}

export const WAITING_ROLE_LABEL: Record<string, string> = {
  product: "运营/产品", engineering: "工程", "ai-content": "AI 内容", "concept-design": "原型/概念设计",
  "asset-production": "量产制作", screenwriter: "专职编剧", "story-author": "长篇故事作者", cinematography: "摄影摄像",
  qa: "测试", cs: "客户成功", eval: "评审", owner: "老板",
};

/** One line: a manager/owner gate names the decision owner; a dependency wait names the role whose phase is awaited. */
export function waitingLabel(w: WaitingFacts): string {
  const phase = w.resumeState === "review" ? "复核" : w.resumeState === "doing" ? "执行" : w.resumeState === "ready" ? "就绪" : "未知阶段";
  const role = w.role === "owner" ? "老板" : w.role === "unknown" ? "未知岗位" : (WAITING_ROLE_LABEL[w.role] ?? w.role);
  const deps = `依赖 ${w.dependenciesCount} 项`;
  if (w.kind === "manager") return `等待经理决定（恢复${phase}）· ${deps}`;
  if (w.kind === "owner") return `等待老板决定（恢复${phase}）· ${deps}`;
  return `等待${role}的${phase}前置（恢复${phase}）· ${deps}`;
}
