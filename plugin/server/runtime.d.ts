// Minimal Bun globals for typechecking ops-repo modules inside the Node plugin runtime.
// server/bun-shim.ts installs the real implementations before importing those modules.
declare const Bun: {
  spawn(cmd: string[], opts: { stdout: string; stderr: string; stdin: string }): {
    exited: Promise<number>;
    stdout: ReadableStream;
    stderr: ReadableStream;
    kill(): void;
  };
  sleep(ms: number): Promise<void>;
  password: {
    hash(v: string, o?: { algorithm?: string }): Promise<string>;
    verify(v: string, h: string): Promise<boolean>;
  };
  serve(o: unknown): unknown;
  argv: string[];
};
