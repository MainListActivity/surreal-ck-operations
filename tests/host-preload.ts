// Test processes run the core on the node execution host, as the local service does. bunfig.toml preloads this file.
import { installNodeHost } from '../src/host-node.ts';

installNodeHost();
