import type { WorkContext } from '../../../src/work-context.ts';
/** Displays company-provided task files, never reads arbitrary paths from a prompt. */
export function WorkContextFiles({value}: {value?: WorkContext}) {
  if (!value) return <p class="hint">此记录尚未保存任务文件快照。</p>;
  return <section class="work-context">
    <p class="hint">{value.source === 'dispatched' ? '本轮派工时写入的文件快照' : '按当前任务生成的预览；线内笔记与返工意见将在派工时按实际身份补充'}</p>
    {value.files.map(file => <details key={file.name} open={file.name === 'task.md'}>
      <summary>{file.name}{file.truncated ? '（显示前 16000 字）' : ''}</summary>
      <pre class="runtime-prompt-full">{file.text}</pre>
    </details>)}
  </section>;
}
