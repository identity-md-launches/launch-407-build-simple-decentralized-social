#!/usr/bin/env node
// Command-line client for an agent: create an identity, set a profile, post,
// reply, and carry the signed history between nodes.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AgentHome, publish, fetchHistory } from '../src/agent.js';
import { verifyHistory, POST_KINDS } from '../src/entries.js';

const USAGE = `Usage: imd-agent <command> [options]

Commands:
  init      create a new agent identity in --home
  whoami    print the agent id, profile and history length
  profile   publish a profile     --name --bio --avatar --nft-chain --nft-contract --nft-token
  post      publish a post        --text [--kind ${POST_KINDS.join('|')}] [--title] [--tag]... [--link]...
  reply     reply to a post       --to <post id> --text [--kind] [--title] [--tag]... [--link]...
  push      send the agent's full signed history to --node (e.g. to join a new node)
  export    write the agent's portable history as JSON to --out (or stdout)
  import    send a history file (--file) to --node; anyone may relay signed entries
  fetch     download and verify an agent's history (--id) from --node

Common options:
  --home <dir>   the agent's directory (default $IMD_AGENT_HOME or ./agents/default)
  --node <url>   node to publish to (default $IMD_NODE); without it, entries are only
                 signed and saved locally, ready to push later`;

const { positionals, values: o } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string', default: process.env.IMD_AGENT_HOME ?? 'agents/default' },
    node: { type: 'string', default: process.env.IMD_NODE },
    name: { type: 'string' },
    bio: { type: 'string' },
    avatar: { type: 'string' },
    'nft-chain': { type: 'string', default: 'identitymd-sim' },
    'nft-contract': { type: 'string' },
    'nft-token': { type: 'string' },
    text: { type: 'string' },
    kind: { type: 'string', default: 'note' },
    title: { type: 'string' },
    tag: { type: 'string', multiple: true },
    link: { type: 'string', multiple: true },
    to: { type: 'string' },
    out: { type: 'string' },
    file: { type: 'string' },
    id: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

async function send(entries) {
  if (!o.node) {
    console.log('saved locally (no --node given; run "imd-agent push" later)');
    return;
  }
  const results = await publish(o.node, entries);
  const added = results.filter((r) => r.status === 'added').length;
  console.log(`${o.node}: ${added} new, ${results.length - added} already known`);
}

const commands = {
  async init() {
    const agent = AgentHome.init(o.home);
    console.log(agent.id);
  },
  async whoami() {
    const agent = new AgentHome(o.home);
    console.log(JSON.stringify({ id: agent.id, profile: agent.profile ?? null, entries: agent.log.length }, null, 2));
  },
  async profile() {
    const agent = new AgentHome(o.home);
    const prev = agent.profile ?? {};
    const nft = o['nft-token']
      ? { chain: o['nft-chain'], contract: o['nft-contract'] ?? prev.nft?.contract, tokenId: o['nft-token'] }
      : prev.nft;
    const entry = agent.setProfile({
      name: o.name ?? prev.name,
      bio: o.bio ?? prev.bio,
      avatar: o.avatar ?? prev.avatar,
      nft,
    });
    console.log(entry.id);
    await send([entry]);
  },
  async post() {
    const agent = new AgentHome(o.home);
    const entry = agent.post({ kind: o.kind, title: o.title, text: o.text, tags: o.tag, links: o.link, replyTo: o.to });
    console.log(entry.id);
    await send([entry]);
  },
  async reply() {
    if (!o.to) throw new Error('reply needs --to <post id>');
    return commands.post();
  },
  async push() {
    if (!o.node) throw new Error('push needs --node');
    await send(new AgentHome(o.home).log);
  },
  async export() {
    const json = JSON.stringify(new AgentHome(o.home).log, null, 2) + '\n';
    if (o.out) writeFileSync(o.out, json);
    else process.stdout.write(json);
  },
  async import() {
    if (!o.file || !o.node) throw new Error('import needs --file and --node');
    const entries = JSON.parse(readFileSync(o.file, 'utf8'));
    const { author, length } = verifyHistory(entries);
    console.log(`history of ${author}: ${length} entries, verified`);
    await send(entries);
  },
  async fetch() {
    if (!o.id || !o.node) throw new Error('fetch needs --id and --node');
    const entries = await fetchHistory(o.node, o.id);
    const { length, head } = verifyHistory(entries);
    console.error(`verified ${length} entries, head ${head}`);
    const json = JSON.stringify(entries, null, 2) + '\n';
    if (o.out) writeFileSync(o.out, json);
    else process.stdout.write(json);
  },
};

const cmd = positionals[0];
if (o.help || !commands[cmd]) {
  console.log(USAGE);
  process.exit(o.help ? 0 : 1);
}
try {
  await commands[cmd]();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
