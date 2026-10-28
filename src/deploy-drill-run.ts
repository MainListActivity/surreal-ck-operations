// Detached drill worker entry. The service process spawns this file by path (startDrill); it must
// exist as its own module for the spawn to resolve, and its environment carries only SCK_DRILL_HOME
// / SCK_DRILL_REPO (never the production database variables — see CHILD_ENV in deploy-drill-service).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runDrillDetached } from './deploy-drill-service.ts';

const runId = process.argv[2];
if (!runId) {
  console.error('usage: deploy-drill-run.ts <runId>');
  process.exit(2);
}
const serviceHome = process.env.SCK_DRILL_HOME ?? join(homedir(), 'Library', 'Application Support', 'SurrealCKCompany');
const repo = process.env.SCK_DRILL_REPO ?? '/Users/y/IdeaProjects/surreal-ck-operations';
await runDrillDetached(serviceHome, repo, runId);
