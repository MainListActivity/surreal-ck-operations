#!/usr/bin/env bun
// One-time dead-path repair for Paseo, run alongside the release deploy (not resident):
//   bun scripts/paseo-dead-path-cleanup.ts           # dry-run: print the plan for the evidence bundle
//   bun scripts/paseo-dead-path-cleanup.ts --apply   # execute exactly the planned entries
// Selection is by path existence only: workspaces whose cwd and projects whose path are gone from
// disk are archived/deleted; live paths (including duplicated live SCK workspaces) are never touched.
import { deadPathCleanup } from '../src/dispatcher/paseo-dead-paths.ts';
import { createPaseoCli } from '../src/dispatcher/paseo.ts';

const apply = process.argv.includes('--apply');
const report = await deadPathCleanup(createPaseoCli(), { apply });
console.log(JSON.stringify(report, null, 2));
console.error(`dead-path cleanup: workspaces=${report.workspaces.length} projects=${report.projects.length} apply=${report.apply}`);
