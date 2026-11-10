import type { PluginServerContext } from '@getpaseo/plugin/server';
import type { RuntimeEventSource } from './vendor/src/runner/host.ts';
import { startDispatch as start } from './vendor/src/runner/dispatch.ts';
import './company';
export * from './vendor/src/runner/dispatch.ts';
export function startDispatch(server: PluginServerContext): () => void {
  return start(server as unknown as RuntimeEventSource);
}
