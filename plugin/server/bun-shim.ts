// The ops repo targets Bun; the plugin subprocess is Node. Provide the small surface it needs.
import { spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { argon2id, argon2Verify } from "hash-wasm";

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
    stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream,
    stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream,
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
      // Bun defaults to argon2id m=65536 t=2 p=1; PHC output stays verify-compatible either way.
      hash: (pw: string) => argon2id({
        password: pw, salt: randomBytes(16), parallelism: 1,
        memorySize: 65536, iterations: 2, hashLength: 32, outputType: "encoded",
      }),
      verify: (pw: string, hash: string) =>
        argon2Verify({ password: pw, hash }).catch(() => false),
    },
    serve: () => { throw new Error("Bun.serve is unavailable in the plugin runtime"); },
    argv: process.argv,
  };
}
