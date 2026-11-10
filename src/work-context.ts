import { taskBrief, latestFindings } from './dispatcher/brief.ts';
import type { ClaimResult } from './contracts.ts';
export interface WorkContext {
  source: 'preview' | 'dispatched';
  at: number;
  delivery?: string;
  files: Array<{ name: string; text: string; truncated: boolean }>;
}
export function workContext(claim: Pick<ClaimResult, 'task'> & Partial<Pick<ClaimResult, 'laneNotes' | 'history' | 'deliveryId'>>, source: WorkContext['source'], at = Date.now()): WorkContext {
  const files: Array<{name: string; text: string}> = [{name: 'task.md', text: taskBrief(claim as ClaimResult)}];
  if (source === 'dispatched') files.push({name: 'notes.md', text: claim.laneNotes ?? '（这条线的笔记暂时读不到，直接按 task.md 干活）\n'});
  const findings = latestFindings(claim.history);
  if (findings) files.push({name: findings.file, text: findings.text});
  return {source, at, delivery: claim.deliveryId, files: files.map(f => ({...f, text: f.text.slice(0, 16000), truncated: f.text.length > 16000}))};
}
