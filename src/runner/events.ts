import type { RuntimeEventSource, RuntimeEvents, RuntimeHost } from './host.ts';
/** 仅在本进程内转发事件，不依赖 daemon、ACP 或网络。 */
export class RuntimeEventsBus implements RuntimeEventSource {
  private readonly listeners = new Map<string, Set<(event: any, context: { paseo: RuntimeHost }) => void | Promise<void>>>();
  constructor(readonly host: RuntimeHost) {}
  on<K extends keyof RuntimeEvents>(name: K, fn: (event: RuntimeEvents[K], context: { paseo: RuntimeHost }) => void | Promise<void>) {
    let entries = this.listeners.get(name);
    if (!entries) { entries = new Set(); this.listeners.set(name, entries); }
    entries.add(fn);
    return () => { entries!.delete(fn); };
  }
  async emit<K extends keyof RuntimeEvents>(name: K, event: RuntimeEvents[K]): Promise<void> {
    await Promise.all([...this.listeners.get(name) ?? []].map(fn => fn(event, { paseo: this.host })));
  }
}
