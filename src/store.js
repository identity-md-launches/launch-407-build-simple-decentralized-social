// A node's storage: an append-only JSON-lines file plus in-memory indexes
// rebuilt on start. Every entry is re-verified when it is loaded.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, verifyEntry } from './entries.js';

function sameEntry(a, b) {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'entries.jsonl');
    this.byId = new Map();
    this.logs = new Map(); // author -> entries in seq order
    this.profiles = new Map(); // author -> latest profile entry
    this.replies = new Map(); // entry id -> ids of posts replying to it
    this.skippedOnLoad = 0;
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          this.#check(entry);
          this.#index(entry);
        } catch {
          this.skippedOnLoad++;
        }
      }
    }
  }

  // Returns 'added' or 'duplicate'; throws StoreError when the entry is
  // invalid ('invalid'), arrives before its predecessors ('gap'), or conflicts
  // with a different entry already accepted at that position ('fork').
  add(entry) {
    const known = entry && this.byId.get(entry.id);
    // An altered copy reusing a known id falls through and fails verification.
    if (known && sameEntry(known, entry)) return 'duplicate';
    this.#check(entry);
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.#index(entry);
    return 'added';
  }

  #check(entry) {
    try {
      verifyEntry(entry);
    } catch (err) {
      throw new StoreError('invalid', err.message);
    }
    const log = this.logs.get(entry.author) ?? [];
    if (entry.seq <= log.length) {
      throw new StoreError('fork', `author already has a different entry at seq ${entry.seq}`);
    }
    if (entry.seq > log.length + 1) {
      throw new StoreError('gap', `missing entries ${log.length + 1}..${entry.seq - 1} for this author`);
    }
    if (entry.prev !== (log.at(-1)?.id ?? null)) {
      throw new StoreError('fork', 'prev does not point at the latest known entry');
    }
  }

  #index(entry) {
    this.byId.set(entry.id, entry);
    if (!this.logs.has(entry.author)) this.logs.set(entry.author, []);
    this.logs.get(entry.author).push(entry);
    if (entry.type === 'profile') this.profiles.set(entry.author, entry);
    const parent = entry.type === 'post' && entry.body.replyTo;
    if (parent) {
      if (!this.replies.has(parent)) this.replies.set(parent, []);
      this.replies.get(parent).push(entry.id);
    }
  }

  get(id) {
    return this.byId.get(id);
  }

  heads() {
    const out = {};
    for (const [author, log] of this.logs) out[author] = log.length;
    return out;
  }

  log(author, after = 0) {
    return (this.logs.get(author) ?? []).slice(after);
  }

  authors() {
    return [...this.logs.keys()];
  }

  profile(author) {
    return this.profiles.get(author)?.body;
  }

  // Posts newest first by the author-claimed timestamp.
  posts({ author, kind, limit = 100 } = {}) {
    const source = author ? this.logs.get(author) ?? [] : this.byId.values();
    const out = [];
    for (const e of source) {
      if (e.type !== 'post') continue;
      if (kind && e.body.kind !== kind) continue;
      out.push(e);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return out.slice(0, limit);
  }

  repliesTo(id) {
    return (this.replies.get(id) ?? [])
      .map((rid) => this.byId.get(rid))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Walks replyTo links upward as far as this node knows them.
  ancestors(entry) {
    const chain = [];
    const seen = new Set([entry.id]);
    let parentId = entry.body.replyTo;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.byId.get(parentId);
      if (!parent) {
        chain.unshift({ missing: parentId });
        break;
      }
      chain.unshift(parent);
      parentId = parent.body.replyTo;
    }
    return chain;
  }

  countReplies(id) {
    let n = 0;
    for (const r of this.replies.get(id) ?? []) n += 1 + this.countReplies(r);
    return n;
  }

  stats() {
    let posts = 0;
    for (const e of this.byId.values()) if (e.type === 'post') posts++;
    return { entries: this.byId.size, agents: this.logs.size, posts };
  }
}
