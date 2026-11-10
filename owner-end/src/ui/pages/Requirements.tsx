import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProductPolicy, Requirement } from '../../../../src/iteration/requirements.ts';
import { runCommand, outcomeText } from '../api.ts';
import { Badge, Dialog, EmptyState, ErrorState, Field, FilterTabs, Loading, NoticeLine, PageHeader, type Notice } from '../common.tsx';
import { REQUIREMENT_GROUPS, groupCounts, inGroup, nextStep, priorityText, stateOf } from '../iteration.ts';
import { hrefOf, splitLines, type Route } from '../model.ts';
import { timeText } from '../common.tsx';
import { FeedbackInbox } from './Feedback.tsx';
import { RequirementCreate, RequirementDetail } from './RequirementDetails.tsx';

export interface Product { id: string; name: string }
export const EMPTY_POLICY: ProductPolicy = { enabled: true, autoRelease: false, feedbackOrigins: [], releaseInstructions: '', verifyInstructions: '', rollbackInstructions: '' };
const PAGE = 100;

export function useProducts() {
  const [products, setProducts] = useState<Product[]>();
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void runCommand<{ products: Product[] }>('product.iteration.list').then(out => {
      if (!active) return;
      if (out.kind === 'ok') setProducts(out.result.products);
      else setError(outcomeText(out, ''));
    }).catch(() => active && setError('产品列表读取失败'));
    return () => { active = false; };
  }, [tick]);
  return { products, error, reload: () => setTick(t => t + 1) };
}

export function RequirementsPage({ route, onDirtyChange }: { route: Route; onDirtyChange(dirty: boolean): void }) {
  const { products, error, reload } = useProducts();
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (route.id === 'new') return <RequirementCreate products={products ?? []} project={route.params.p} onDirtyChange={onDirtyChange} />;
  if (route.id) return <RequirementDetail key={route.id} id={route.id} products={products ?? []} onDirtyChange={onDirtyChange} />;
  return <RequirementList route={route} products={products} productError={error} reloadProducts={reload} onDirtyChange={onDirtyChange} />;
}

function go(params: Record<string, string | undefined>) {
  location.hash = hrefOf('requirements', undefined, params);
}

function RequirementList({ route, products, productError, reloadProducts, onDirtyChange }: {
  route: Route;
  products?: Product[];
  productError: string;
  reloadProducts(): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const project = route.params.p ?? '';
  const view = route.params.view === 'feedback' ? 'feedback' : 'list';
  const group = REQUIREMENT_GROUPS.some(g => g.id === route.params.s) ? route.params.s! : 'all';
  const settingsOpen = route.params.settings === '1';
  const params = { p: project || undefined, view: view === 'feedback' ? 'feedback' : undefined, s: group === 'all' ? undefined : group };

  const [items, setItems] = useState<Requirement[]>();
  const [stages, setStages] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const [policy, setPolicy] = useState<ProductPolicy>();
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const generation = useRef(0);

  useEffect(() => { setOffset(0); }, [project]);

  useEffect(() => {
    const current = ++generation.current;
    setError('');
    setItems(undefined);
    void runCommand<{ requirements: Requirement[] }>('requirement.list', { ...(project ? { project } : {}), offset }).then(async out => {
      if (current !== generation.current) return;
      if (out.kind !== 'ok') { setError(outcomeText(out, '')); return; }
      setItems(out.result.requirements);
      // 待发布的需求再读执行阶段，区分「等你确认发布」与「发布流程未配置」等。
      const pending = out.result.requirements.filter(r => r.state === 'release_pending' || r.state === 'implementing').slice(0, 20);
      const found: Record<string, string> = {};
      await Promise.all(pending.map(async r => {
        const ex = await runCommand<{ execution: { stage: string } | null }>('requirement.execution', { id: r.id }).catch(() => undefined);
        if (ex?.kind === 'ok' && ex.result.execution?.stage) found[r.id] = ex.result.execution.stage;
      }));
      if (current === generation.current) setStages(found);
    }).catch(() => current === generation.current && setError('需求列表读取失败'));
  }, [project, offset, tick]);

  useEffect(() => {
    let active = true;
    setPolicy(undefined);
    setPolicyLoaded(false);
    if (!project) return;
    void runCommand<{ policy: ProductPolicy | null }>('product.iteration.get', { project }).then(out => {
      if (!active) return;
      if (out.kind === 'ok') { setPolicy(out.result.policy ?? undefined); setPolicyLoaded(true); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [project, tick]);

  const productName = (id: string) => products?.find(p => p.id === id)?.name ?? id;
  const counts = useMemo(() => groupCounts(items ?? []), [items]);
  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => (items ?? [])
    .filter(r => inGroup(r.state, group) && (!needle || r.title.toLowerCase().includes(needle) || r.problem.toLowerCase().includes(needle)))
    .map(r => ({ r, next: nextStep(r, stages[r.id]) }))
    .sort((a, b) => Number(b.next.owner) - Number(a.next.owner) || a.r.priority - b.r.priority || String(b.r.updated_at).localeCompare(String(a.r.updated_at))),
  [items, group, needle, stages]);
  const decide = (items ?? []).filter(r => nextStep(r, stages[r.id]).owner).length;

  const product = products?.find(p => p.id === project);

  return (
    <div class="page">
      <PageHeader
        title="需求"
        description="用户反馈由 Agent 整理成需求；你确认开工后，修订锁定并交给 Agent 拆解执行。上线需要你单独授权。"
        actions={(
          <>
            {project ? <a class="button" href={hrefOf('requirements', undefined, { ...params, settings: '1' })}>产品设置</a> : null}
            <a class="button primary" href={hrefOf('requirements', 'new', { p: project || undefined })}>新建需求</a>
          </>
        )}
      />

      <div class="toolbar product-bar">
        <label class="inline-field">
          <span>产品</span>
          <select value={project} onChange={e => go({ ...params, p: e.currentTarget.value || undefined, view: e.currentTarget.value ? params.view : undefined })}>
            <option value="">全部产品</option>
            {(products ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div class="view-switch" role="group" aria-label="视图">
          <a class="seg" href={hrefOf('requirements', undefined, { ...params, view: undefined })} aria-current={view === 'list' ? 'page' : undefined}>需求池</a>
          <a class="seg" href={hrefOf('requirements', undefined, { ...params, view: 'feedback' })} aria-current={view === 'feedback' ? 'page' : undefined}>用户反馈</a>
        </div>
        {project && policyLoaded && !policy?.enabled ? <Badge tone="blocked">迭代未启用</Badge> : null}
        {project && policyLoaded && policy?.enabled ? <Badge tone="neutral">{policy.autoRelease ? '验收后自动发布' : '上线需你确认'}</Badge> : null}
      </div>

      {productError ? <ErrorState title="产品列表读取失败" message={productError} onRetry={reloadProducts} /> : null}
      <NoticeLine notice={notice} onClose={() => setNotice(null)} />

      {view === 'feedback' ? (
        project
          ? <FeedbackInbox key={project} project={project} />
          : (
            <EmptyState title="请选择一个产品查看反馈">
              反馈按产品收集。选择产品后，可以看到用户原文、Agent 的整理理由和关联的需求。
              {products?.length ? <span class="chip-row">{products.map(p => <a key={p.id} class="chip" href={hrefOf('requirements', undefined, { p: p.id, view: 'feedback' })}>{p.name}</a>)}</span> : null}
            </EmptyState>
          )
      ) : (
        <>
          <div class="toolbar">
            <FilterTabs label="按需求状态筛选" value={group} onChange={id => go({ ...params, s: id === 'all' ? undefined : id })} items={REQUIREMENT_GROUPS.map(g => ({ id: g.id, label: g.label, count: counts[g.id] ?? 0 }))} />
            <label class="search">
              <span class="visually-hidden">搜索需求</span>
              <input type="search" placeholder="搜索标题或问题描述" value={query} onInput={e => setQuery(e.currentTarget.value)} />
            </label>
          </div>
          {items && decide ? <p class="list-summary"><strong>{decide}</strong> 条需要你处理，已排在最前。</p> : null}
          {error ? <ErrorState message={error} onRetry={() => setTick(t => t + 1)} /> : null}
          {!items && !error ? <Loading label="正在读取需求…" rows={5} /> : null}
          {items && !rows.length ? (
            items.length ? (
              <EmptyState title="没有符合条件的需求" action={<button type="button" onClick={() => { setQuery(''); go({ ...params, s: undefined }); }}>清除筛选</button>}>
                换一个状态或搜索词看看。
              </EmptyState>
            ) : (
              <EmptyState
                title={product ? `「${product.name}」还没有需求` : products && !products.length ? '还没有登记产品' : '还没有需求'}
                action={products?.length ? <a class="button primary" href={hrefOf('requirements', 'new', { p: project || undefined })}>新建需求</a> : undefined}
              >
                {products && !products.length ? '登记产品项目后，用户反馈会在这里整理成需求。' : '用户反馈经 Agent 整理后会出现在这里；你也可以直接新建需求。'}
              </EmptyState>
            )
          ) : null}
          {rows.length ? (
            <div class="table-wrap">
              <table class="data-table req-table">
                <thead>
                  <tr><th scope="col">需求</th><th scope="col">状态</th><th scope="col">下一步</th><th scope="col">优先级</th><th scope="col">更新</th></tr>
                </thead>
                <tbody>
                  {rows.map(({ r, next }) => {
                    const st = stateOf(r.state);
                    return (
                      <tr key={r.id} class={next.owner ? 'needs-owner' : undefined}>
                        <td class="cell-title">
                          <a class="row-link" href={hrefOf('requirements', r.id)}>{r.title}</a>
                          <span class="cell-sub">{productName(r.project)} · 修订 {r.revision}</span>
                        </td>
                        <td data-label="状态"><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td data-label="下一步"><span class={`next-step tone-${next.tone}`}>{next.text}</span></td>
                        <td data-label="优先级"><span class={`priority p${r.priority}`}>{priorityText(r.priority)}</span></td>
                        <td data-label="更新" class="cell-time">{timeText(r.updated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {items && (offset > 0 || items.length >= PAGE) ? (
            <div class="pager">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>上一页</button>
              <span>第 {offset / PAGE + 1} 页 · 筛选与计数只作用于本页</span>
              <button type="button" disabled={items.length < PAGE} onClick={() => setOffset(offset + PAGE)}>下一页</button>
            </div>
          ) : null}
        </>
      )}

      {settingsOpen && project ? (
        <PolicyDialog
          key={project}
          productName={product?.name ?? project}
          initial={policy ?? EMPTY_POLICY}
          loaded={policyLoaded}
          onDirtyChange={onDirtyChange}
          onClose={() => { onDirtyChange(false); go(params); }}
          save={async value => {
            const out = await runCommand('product.iteration.configure', { project, ...value });
            if (out.kind !== 'ok') return outcomeText(out, '');
            setPolicy(value);
            setNotice({ tone: 'ok', text: '产品设置已保存。已确认的需求仍按确认时的授权快照执行。' });
            setTick(t => t + 1);
            return undefined;
          }}
        />
      ) : null}
    </div>
  );
}

/** 产品设置：迭代开关、反馈来源、发布方式与发布/验证/回退流程。 */
export function PolicyDialog({ productName, initial, loaded, save, onClose, onDirtyChange }: {
  productName: string;
  initial: ProductPolicy;
  loaded: boolean;
  save(p: ProductPolicy): Promise<string | undefined>;
  onClose(): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const [value, setValue] = useState(initial);
  const [origins, setOrigins] = useState(initial.feedbackOrigins.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => { setValue(initial); setOrigins(initial.feedbackOrigins.join('\n')); }, [initial]);
  const next: ProductPolicy = { ...value, feedbackOrigins: splitLines(origins) };
  const dirty = JSON.stringify(next) !== JSON.stringify({ ...initial, feedbackOrigins: initial.feedbackOrigins });
  const report = useCallback(onDirtyChange, [onDirtyChange]);
  useEffect(() => { report(dirty); }, [dirty, report]);
  const missing = value.autoRelease && (!value.releaseInstructions.trim() || !value.verifyInstructions.trim() || !value.rollbackInstructions.trim());
  const close = () => { if (dirty && !busy) setConfirmClose(true); else onClose(); };
  const submit = async () => {
    setBusy(true);
    setError('');
    const problem = await save(next).catch(() => '保存失败，请稍后重试');
    setBusy(false);
    if (problem) setError(problem);
    else { onDirtyChange(false); onClose(); }
  };
  const fields = [
    { key: 'releaseInstructions', label: '发布流程', hint: 'Agent 如何把交付部署到生产环境。' },
    { key: 'verifyInstructions', label: '上线验证方法', hint: '上线后如何确认功能正常。' },
    { key: 'rollbackInstructions', label: '回退流程', hint: '出现问题时如何恢复上一版本。' },
  ] as const;
  return (
    <Dialog
      wide
      title={`产品设置 · ${productName}`}
      onClose={close}
      footer={confirmClose ? (
        <>
          <span class="foot-note">放弃未保存的设置？</span>
          <button type="button" data-autofocus onClick={() => setConfirmClose(false)}>继续编辑</button>
          <button type="button" class="danger" onClick={() => { onDirtyChange(false); onClose(); }}>放弃修改</button>
        </>
      ) : (
        <>
          {dirty ? <span class="foot-note unsaved">有未保存的修改</span> : null}
          <button type="button" disabled={busy} onClick={close}>取消</button>
          <button type="button" class="primary" disabled={busy || !loaded || !dirty || missing} onClick={() => void submit()}>{busy ? '正在保存…' : '保存设置'}</button>
        </>
      )}
    >
      {!loaded ? <Loading label="正在读取产品设置…" /> : (
        <form class="form" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <p class="hint">设置只影响之后的确认与发布；已确认的需求保留确认时的授权快照。停用后不再自动整理反馈，也不推进后续任务。</p>
          {error ? <div class="notice err" role="alert"><span class="notice-text">{error}</span></div> : null}
          <label class="check"><input type="checkbox" checked={value.enabled} disabled={busy} onChange={e => setValue({ ...value, enabled: e.currentTarget.checked })} /><span><strong>启用迭代流程</strong><small>关闭后不能确认新的需求开工。</small></span></label>
          <label class="check"><input type="checkbox" checked={value.autoRelease} disabled={busy} onChange={e => setValue({ ...value, autoRelease: e.currentTarget.checked })} /><span><strong>验收通过后自动发布</strong><small>需要同时填写发布、验证和回退流程。不勾选时，每次上线都等你确认。</small></span></label>
          {fields.map(f => (
            <Field key={f.key} label={f.label} hint={f.hint} required={value.autoRelease} count={value[f.key].length} max={2000} error={value.autoRelease && !value[f.key].trim() ? '自动发布时必填' : undefined}>
              <textarea rows={3} maxLength={2000} value={value[f.key]} disabled={busy} onInput={e => setValue({ ...value, [f.key]: e.currentTarget.value })} />
            </Field>
          ))}
          <Field label="允许嵌入反馈入口的站点" hint="每行一个完整的 HTTPS 来源，例如 https://app.example.com，不含路径。最多 20 个。">
            <textarea rows={3} value={origins} disabled={busy} onInput={e => setOrigins(e.currentTarget.value)} />
          </Field>
        </form>
      )}
    </Dialog>
  );
}
