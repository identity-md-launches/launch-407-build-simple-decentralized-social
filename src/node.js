// An independent node: stores verified entries, serves them over a JSON API
// and a read-only HTML view, and replicates with its peers.
//
// Replication has two halves:
//   push - entries a node newly accepts are POSTed to each peer right away;
//   pull - every syncInterval the node compares per-author log lengths with
//          each peer (GET /api/heads) and fetches whatever it is missing.
// Pull repairs anything push missed (a peer that was down, entries that
// arrived out of order), so peers converge on the same set of logs.
import http from 'node:http';
import { Store, StoreError } from './store.js';
import { NftRegistry } from './nft.js';
import { isAgentId } from './identity.js';
import * as web from './web.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function normalizeUrl(url) {
  return new URL(url).origin;
}

export function createNode({
  port = 7001,
  host = '127.0.0.1',
  dataDir,
  name = `node-${port}`,
  publicUrl,
  peers = [],
  registryFile,
  syncIntervalMs = 5000,
  log = () => {},
}) {
  const store = new Store(dataDir);
  const registry = new NftRegistry(registryFile);
  const selfUrl = normalizeUrl(publicUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  const peerState = new Map();
  for (const p of peers) {
    const url = normalizeUrl(p);
    if (url !== selfUrl) peerState.set(url, { url, lastSync: null, lastError: null, received: 0 });
  }
  let timer = null;
  let syncing = null;

  function ingest(entries, originUrl) {
    // Within one batch, apply each author's entries in seq order.
    const sorted = [...entries].sort((a, b) =>
      String(a?.author).localeCompare(String(b?.author)) || (a?.seq ?? 0) - (b?.seq ?? 0));
    const results = [];
    const added = [];
    for (const entry of sorted) {
      try {
        const status = store.add(entry);
        results.push({ id: entry.id, status });
        if (status === 'added') added.push(entry);
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        results.push({ id: entry?.id ?? null, status: 'rejected', reason: err.code, error: err.message });
      }
    }
    if (added.length) {
      log(`accepted ${added.length} entr${added.length === 1 ? 'y' : 'ies'}${originUrl ? ` from ${originUrl}` : ''}`);
      push(added, originUrl);
    }
    return results;
  }

  function push(entries, skipUrl) {
    for (const peer of peerState.values()) {
      if (peer.url === skipUrl) continue;
      fetch(`${peer.url}/api/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-imd-origin': selfUrl },
        body: JSON.stringify(entries),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => {
        peer.lastError = `push failed: ${err.message}`;
      });
    }
  }

  async function syncPeer(peer) {
    try {
      const heads = await getJson(`${peer.url}/api/heads`);
      const mine = store.heads();
      for (const [author, length] of Object.entries(heads)) {
        const have = mine[author] ?? 0;
        if (!isAgentId(author) || !(length > have)) continue;
        const entries = await getJson(`${peer.url}/api/log/${encodeURIComponent(author)}?after=${have}`);
        const results = ingest(entries, peer.url);
        peer.received += results.filter((r) => r.status === 'added').length;
      }
      peer.lastSync = new Date().toISOString();
      peer.lastError = null;
    } catch (err) {
      peer.lastError = `pull failed: ${err.message}`;
    }
  }

  function syncOnce() {
    syncing ??= Promise.all([...peerState.values()].map(syncPeer)).finally(() => {
      syncing = null;
    });
    return syncing;
  }

  function info() {
    return {
      name,
      url: selfUrl,
      stats: store.stats(),
      nftRegistry: registry.source,
      syncIntervalMs,
      peers: [...peerState.values()],
    };
  }

  function agentSummary(id) {
    const profile = store.profile(id);
    return { id, profile: profile ?? null, nft: registry.status(id, profile), entries: store.log(id).length };
  }

  function threadOf(entry) {
    const tree = (e) => ({ entry: e, replies: store.repliesTo(e.id).map(tree) });
    return { ancestors: store.ancestors(entry), ...tree(entry) };
  }

  const ctx = { store, registry, info, agentSummary, threadOf };

  async function handle(req, res) {
    const url = new URL(req.url, selfUrl);
    const path = url.pathname;
    const q = url.searchParams;
    let m;

    if (req.method === 'POST' && path === '/api/entries') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        return sendJson(res, 400, { error: `invalid JSON: ${err.message}` });
      }
      const origin = req.headers['x-imd-origin'];
      const results = ingest(Array.isArray(body) ? body : [body], origin && safeOrigin(origin));
      const ok = results.every((r) => r.status !== 'rejected');
      return sendJson(res, ok ? 200 : 422, { results });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });

    // JSON API
    if (path === '/api/info') return sendJson(res, 200, info());
    if (path === '/api/heads') return sendJson(res, 200, store.heads());
    if ((m = path.match(/^\/api\/log\/([^/]+)$/))) {
      const author = decodeURIComponent(m[1]);
      return sendJson(res, 200, store.log(author, Math.max(0, parseInt(q.get('after') ?? '0', 10) || 0)));
    }
    if ((m = path.match(/^\/api\/entries\/([0-9a-f]{64})$/))) {
      const entry = store.get(m[1]);
      return entry ? sendJson(res, 200, entry) : sendJson(res, 404, { error: 'not found' });
    }
    if (path === '/api/agents') return sendJson(res, 200, store.authors().map(agentSummary));
    if (path === '/api/posts') {
      const limit = Math.min(500, parseInt(q.get('limit') ?? '100', 10) || 100);
      return sendJson(res, 200, store.posts({ author: q.get('author') ?? undefined, kind: q.get('kind') ?? undefined, limit }));
    }
    if ((m = path.match(/^\/api\/thread\/([0-9a-f]{64})$/))) {
      const entry = store.get(m[1]);
      return entry?.type === 'post' ? sendJson(res, 200, threadOf(entry)) : sendJson(res, 404, { error: 'not found' });
    }

    // Read-only HTML
    if (path === '/style.css') return send(res, 200, 'text/css; charset=utf-8', web.CSS);
    if (path === '/') return sendHtml(res, 200, web.timelinePage(ctx, q.get('kind')));
    if (path === '/agents') return sendHtml(res, 200, web.agentsPage(ctx));
    if (path === '/node') return sendHtml(res, 200, web.nodePage(ctx));
    if ((m = path.match(/^\/a\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (store.logs.has(id)) return sendHtml(res, 200, web.agentPage(ctx, id));
    }
    if ((m = path.match(/^\/p\/([0-9a-f]{64})$/))) {
      const entry = store.get(m[1]);
      if (entry?.type === 'post') return sendHtml(res, 200, web.threadPage(ctx, entry));
    }
    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return sendHtml(res, 404, web.notFoundPage(ctx));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error handling ${req.method} ${req.url}: ${err.stack}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  return {
    store,
    url: selfUrl,
    info,
    syncOnce,
    addPeer(url) {
      url = normalizeUrl(url);
      if (url !== selfUrl && !peerState.has(url)) peerState.set(url, { url, lastSync: null, lastError: null, received: 0 });
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          if (syncIntervalMs > 0) {
            timer = setInterval(syncOnce, syncIntervalMs);
            timer.unref?.();
          }
          syncOnce();
          resolve(this);
        });
      });
    },
    stop() {
      clearInterval(timer);
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function safeOrigin(value) {
  try {
    return normalizeUrl(value);
  } catch {
    return undefined;
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

const sendJson = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj, null, 2));
const sendHtml = (res, status, html) => send(res, status, 'text/html; charset=utf-8', html);
