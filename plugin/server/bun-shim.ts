// The ops repo targets Bun; the plugin subprocess is Node. Provide the small surface it needs.
import { spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { Readable } from "node:stream";

interface SpawnedChild {
  exited: Promise<number>;
  stdout: ReadableStream;
  stderr: ReadableStream;
  kill(): void;
}

const spawn = (cmd: string[], opts: { stdout: string; stderr: string; stdin: string }): SpawnedChild => {
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
  const child = nodeSpawn(cmd[0], cmd.slice(1), { stdio });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => resolve(code ?? 1));
  });
  return {
    exited,
    stdout: Readable.toWeb(child.stdout!) as ReadableStream,
    stderr: Readable.toWeb(child.stderr!) as ReadableStream,
    kill: () => child.kill(),
  };
};

export function installBunShim(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.Bun) return;
  g.Bun = {
    spawn,
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    password: {
      hash: () => Promise.reject(new Error("Bun.password is unavailable in the plugin runtime")),
      verify: () => Promise.reject(new Error("Bun.password is unavailable in the plugin runtime")),
    },
    serve: () => { throw new Error("Bun.serve is unavailable in the plugin runtime"); },
    argv: process.argv,
  };
}
