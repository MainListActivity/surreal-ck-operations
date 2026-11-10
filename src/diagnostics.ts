// These diagnostics contain durations and fixed operation names only. Never SQL, arguments, results or error text.
let activeAuthLookups = 0;
export async function authenticationLookup<T>(hash: () => string, query: (digest: string) => PromiseLike<T>): Promise<T> {
  const start = performance.now();
  const concurrentAtStart = ++activeAuthLookups;
  let digestMs = 0, queryStart: number | undefined, queryOk = false;
  try {
    const digest = hash();
    digestMs = performance.now() - start;
    queryStart = performance.now();
    const result = await query(digest);
    queryOk = true;
    return result;
  } finally {
    activeAuthLookups--;
    const end = performance.now();
    // query is client-observed RPC time: network, connection queue and server execution combined.
    console.log(`auth timing: query=${Math.round(queryStart === undefined ? 0 : end - queryStart)}ms digest=${Math.round(digestMs)}ms total=${Math.round(end - start)}ms concurrentAtStart=${concurrentAtStart} queryOk=${queryOk}`);
  }
}

type Stage = "iterations" | 'init' | 'config' | 'quota' | 'models' | 'gc' | 'tick' | 'observation' | 'board' | 'heartbeat';
export class DispatchTimings {
  private readonly start: number;
  private readonly stages: Partial<Record<Stage, number>> = {};
  private failedStage?: Stage;
  constructor(private readonly clock = () => performance.now()) { this.start = clock(); }
  async measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
    const start = this.clock();
    try { return await operation(); }
    catch (error) { this.failedStage = stage; throw error; }
    finally { this.stages[stage] = Math.round(this.clock() - start); }
  }
  summary() {
    return { totalMs: Math.round(this.clock() - this.start), stagesMs: { ...this.stages },
      ok: this.failedStage === undefined, ...(this.failedStage ? { failedStage: this.failedStage } : {}) };
  }
}
