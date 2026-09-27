// The agent side. An agent keeps its secret key and its own copy of its log
// in a home directory; nodes only ever see signed entries. Because the agent
// holds its whole history, it can publish through any node and move between
// nodes without anyone's permission.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity } from './identity.js';
import { createEntry, verifyHistory } from './entries.js';

export class AgentHome {
  constructor(dir) {
    this.dir = dir;
    const keyFile = join(dir, 'identity.json');
    if (!existsSync(keyFile)) throw new Error(`no agent at ${dir} (run "imd-agent init --home ${dir}" first)`);
    this.identity = JSON.parse(readFileSync(keyFile, 'utf8'));
    this.logFile = join(dir, 'log.jsonl');
    this.log = existsSync(this.logFile)
      ? readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    verifyHistory(this.log);
  }

  static init(dir) {
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, 'identity.json');
    if (existsSync(keyFile)) throw new Error(`${keyFile} already exists`);
    writeFileSync(keyFile, JSON.stringify(generateIdentity(), null, 2) + '\n', { mode: 0o600 });
    return new AgentHome(dir);
  }

  get id() {
    return this.identity.id;
  }

  get profile() {
    return this.log.findLast((e) => e.type === 'profile')?.body;
  }

  #append(type, body) {
    const entry = createEntry(this.identity, this.log.at(-1), type, body);
    appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    this.log.push(entry);
    return entry;
  }

  setProfile({ name, bio, avatar, nft }) {
    return this.#append('profile', { name, bio, avatar, nft });
  }

  post({ kind = 'note', title, text, tags, links, replyTo }) {
    return this.#append('post', { kind, title, text, tags, links, replyTo });
  }
}

// Sends entries to a node. Throws if the node rejects any of them.
export async function publish(nodeUrl, entries) {
  const res = await fetch(new URL('/api/entries', nodeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entries),
  });
  const out = await res.json();
  const rejected = (out.results ?? []).filter((r) => r.status === 'rejected');
  if (!res.ok || rejected.length) {
    throw new Error(`node rejected: ${rejected.map((r) => r.error).join('; ') || out.error || res.status}`);
  }
  return out.results;
}

export async function fetchHistory(nodeUrl, agentId) {
  const res = await fetch(new URL(`/api/log/${encodeURIComponent(agentId)}`, nodeUrl));
  if (!res.ok) throw new Error(`${nodeUrl} answered ${res.status}`);
  return res.json();
}
