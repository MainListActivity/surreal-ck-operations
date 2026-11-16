import { SANDBOX_MARKER, scrubEnv } from './launch-env.ts';

type Env = Record<string, string | undefined>;

/**
 * The environment a native employee CLI starts with. run.ts passes the daemon's own environment as `inherited`
 * and calls this function from its environment hook; tests call the same function, so the merge they check is
 * the one that launches employees. Order is the boundary: every inherited credential is blanked first, then the
 * task's channel values, the sandbox marker, the model route and the lane settings apply, and ZDOTDIR points at
 * the zsh shim last, so nothing the daemon inherited can redirect the shell's startup files.
 */
export function nativeEmployeeEnv(parts: {
  inherited: Env;
  channel: Record<string, string>;
  modelEnv: Record<string, string>;
  lane: Record<string, string>;
  zdotdir: string;
}): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(parts.inherited).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { ...inherited, ...scrubEnv(parts.channel, inherited), ...SANDBOX_MARKER, ...parts.modelEnv, ...parts.lane, PASEO_AGENT_ID: "", ZDOTDIR: parts.zdotdir };
}
