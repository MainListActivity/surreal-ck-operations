// Test processes run the core on the node execution host, as the local service does. bunfig.toml preloads this file.
// Plugin tests load the vendored copy of src/ (plugin/scripts/vendor.sh). It is another module instance with its own host
// slot, which the plugin fills at its entry (plugin/index.server.ts), so the test host goes into that copy too.
import { existsSync } from 'node:fs';
import { installNodeHost } from '../src/host-node.ts';

installNodeHost();

const vendoredHostNode = new URL('../plugin/server/vendor/src/host-node.ts', import.meta.url);
if (existsSync(vendoredHostNode)) (await import(vendoredHostNode.href)).installNodeHost();
