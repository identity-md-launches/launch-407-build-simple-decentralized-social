#!/usr/bin/env node
// Runs one independent node.
import { parseArgs } from 'node:util';
import { createNode } from '../src/node.js';

const USAGE = `Usage: imd-node [options]

  --port <n>            port to listen on (default 7001, or $PORT)
  --host <addr>         address to bind (default 127.0.0.1; use 0.0.0.0 to expose)
  --data <dir>          where this node stores entries (default ./data/<port>)
  --name <text>         display name for this node
  --public-url <url>    the URL peers should use to reach this node
  --peer <url>          another node to replicate with (repeatable)
  --registry <file>     IdentityMD NFT registry JSON (simulated chain)
  --sync-interval <s>   seconds between pulls from peers (default 5)
  -h, --help`;

const { values: o } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '7001' },
    host: { type: 'string', default: '127.0.0.1' },
    data: { type: 'string' },
    name: { type: 'string' },
    'public-url': { type: 'string' },
    peer: { type: 'string', multiple: true, default: [] },
    registry: { type: 'string' },
    'sync-interval': { type: 'string', default: '5' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (o.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = Number(o.port);
const node = createNode({
  port,
  host: o.host,
  dataDir: o.data ?? `data/${port}`,
  name: o.name,
  publicUrl: o['public-url'],
  peers: o.peer,
  registryFile: o.registry,
  syncIntervalMs: Number(o['sync-interval']) * 1000,
  log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
});
await node.start();
const { stats, peers, nftRegistry } = node.info();
console.log(`node listening at ${node.url}`);
console.log(`  holding ${stats.entries} entries from ${stats.agents} agents`);
console.log(`  peers: ${peers.map((p) => p.url).join(', ') || 'none'}`);
console.log(`  NFT registry: ${nftRegistry}`);
if (node.store.skippedOnLoad) console.log(`  skipped ${node.store.skippedOnLoad} stored entries that failed verification`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await node.stop();
    process.exit(0);
  });
}
