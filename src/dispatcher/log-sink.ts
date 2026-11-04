import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * FV06: the dispatcher's log used to exist only on the console, so every recovery wake, skip and failure it wrote
 * lived in Paseo's own log surface and could not be audited from the service home. This sink appends the same line
 * to `<serviceHome>/logs/dispatcher.log` with an ISO timestamp, so wake/skip/fail decisions stay readable next to
 * the services they are about.
 *
 * Best effort by construction: the console line has already been written, and a full disk or a missing directory
 * must never stop dispatch.
 */
export function dispatcherLogSink(serviceHome: string): (message: string) => void {
  const dir = join(serviceHome, 'logs');
  const file = join(dir, 'dispatcher.log');
  let ready = false;
  return (message: string) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        ready = true;
      }
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // The console line is the primary record; the file copy is an audit convenience.
    }
  };
}
