import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDatabaseConfig } from '../config.ts';
import { CompanyDatabase } from '../database.ts';
import { OwnerDesk } from '../owner.ts';
import { Workforce } from '../workforce.ts';
import { passLedger } from '../dispatch-pause.ts';
import { Dispatcher } from './dispatcher.ts';
import { jevFromEnv } from './jev.ts';
import { createPaseoCli } from './paseo.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function notify(title: string, text: string) {
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240);
  const child = Bun.spawn(['/usr/bin/osascript', '-e', `display notification "${escape(text)}" with title "${escape(title)}"`],
    { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
}

const db = new CompanyDatabase(loadDatabaseConfig());
await db.connect();
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
try {
  await db.bootstrap();
  const workforce = new Workforce(db, resolve(required('SCK_CREDENTIAL_DIR')));
  const dispatcher = new Dispatcher({
    workforce, owner: new OwnerDesk(db), paseo: createPaseoCli(),
    env: { opsRepo: required('SCK_AGENT_CWD'), sckBin: required('SCK_TOOL_BIN'),
      paseoBin: process.env.SCK_PASEO_BIN ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo' },
    notify: process.env.SCK_NOTIFY === '0' ? undefined : notify,
    log: message => console.log(`${new Date().toISOString()} ${message}`),
    jev: jevFromEnv(),
    passes: passLedger(db.db),
    // WT01: managed/legacy scenes must survive; no destructive sweeper.
    // `auto:<family>` defs resolve through the slot map the Paseo plugin maintains;
    // without it this fallback dispatcher cannot spawn auto defs at all.
    models: async () => {
      const [rows] = await db.db.query<[{ slots?: Record<string, string> }[]]>(
        'SELECT slots FROM company_meta:model_slots;');
      return rows?.[0]?.slots ?? {};
    },
  });
  console.log(`${new Date().toISOString()} dispatcher started${jevFromEnv() ? ' (jev enabled)' : ''}`);
  let failures = 0;
  while (!stop.signal.aborted) {
    let wait = (await workforce.config()).pollSeconds * 1000;
    try {
      const report = await dispatcher.tick();
      failures = 0;
      const changed = report.commands || report.revoked.length || report.woke.length || report.retired.length ||
        report.exhausted.length || report.notices.length || report.evals.length || report.decisions.length ||
        report.reclaimed;
      if (changed) console.log(`${new Date().toISOString()} tick ${JSON.stringify(report)}`);
    } catch (error) {
      failures++;
      wait = Math.min(wait * 2 ** Math.min(failures, 5), 300_000);
      console.error(`${new Date().toISOString()} tick failed: ${(error as Error).message}`);
      await db.ensureConnected().catch(() => undefined);
    }
    await delay(wait, undefined, { signal: stop.signal }).catch(() => undefined);
  }
} finally {
  await db.close();
}
