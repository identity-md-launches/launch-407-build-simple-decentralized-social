import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode } from '../src/node.js';
import { AgentHome, publish, fetchHistory } from '../src/agent.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'imd-net-'));

async function eventually(check, ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('two nodes replicate a conversation and serve the same thread', async (t) => {
  const dir = tmp();
  const ada = AgentHome.init(join(dir, 'ada'));
  const bob = AgentHome.init(join(dir, 'bob'));
  const registry = join(dir, 'registry.json');
  writeFileSync(registry, JSON.stringify({ chain: 'sim', contract: '0xC', tokens: { 1: { agent: ada.id, owner: '0x1' } } }));

  const a = createNode({ port: 7311, dataDir: join(dir, 'a'), peers: ['http://127.0.0.1:7312'], registryFile: registry, syncIntervalMs: 200 });
  const b = createNode({ port: 7312, dataDir: join(dir, 'b'), peers: ['http://127.0.0.1:7311'], registryFile: registry, syncIntervalMs: 200 });
  await a.start();
  await b.start();
  t.after(() => Promise.all([a.stop(), b.stop()]));

  await publish(a.url, [ada.setProfile({ name: 'Ada', nft: { chain: 'sim', contract: '0xc', tokenId: '1' } })]);
  await publish(b.url, [bob.setProfile({ name: 'Ada', nft: { chain: 'sim', contract: '0xC', tokenId: '1' } })]);
  const root = ada.post({ kind: 'discovery', text: 'found something' });
  await publish(a.url, [root]);
  await eventually(() => b.store.get(root.id));
  const reply = bob.post({ kind: 'idea', text: 'nice', replyTo: root.id });
  await publish(b.url, [reply]);
  await eventually(() => a.store.get(reply.id));

  const [ta, tb] = await Promise.all([a, b].map((n) => fetch(`${n.url}/api/thread/${root.id}`).then((r) => r.json())));
  assert.deepEqual(ta, tb);
  assert.equal(ta.replies[0].entry.id, reply.id);

  const agents = await fetch(`${a.url}/api/agents`).then((r) => r.json());
  const state = Object.fromEntries(agents.map((x) => [x.id, x.nft.state]));
  assert.equal(state[ada.id], 'verified');
  assert.equal(state[bob.id], 'mismatch');

  for (const path of ['/', '/agents', '/node', `/p/${root.id}`, `/a/${encodeURIComponent(ada.id)}`]) {
    const res = await fetch(a.url + path);
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<!doctype html>/);
  }
});

test('pull sync catches up a node that was offline, and histories move between nodes', async (t) => {
  const dir = tmp();
  const ada = AgentHome.init(join(dir, 'ada'));
  const a = createNode({ port: 7321, dataDir: join(dir, 'a'), peers: ['http://127.0.0.1:7322'], syncIntervalMs: 0 });
  await a.start();
  t.after(() => a.stop());
  // Node B is not running yet, so these pushes fail silently.
  await publish(a.url, [ada.setProfile({ name: 'Ada' }), ada.post({ kind: 'note', text: 'while you were away' })]);

  const b = createNode({ port: 7322, dataDir: join(dir, 'b'), peers: ['http://127.0.0.1:7321'], syncIntervalMs: 0 });
  await b.start();
  t.after(() => b.stop());
  await b.syncOnce();
  assert.equal(b.store.heads()[ada.id], 2);

  // A third node with no peers accepts the whole portable history.
  const c = createNode({ port: 7323, dataDir: join(dir, 'c'), syncIntervalMs: 0 });
  await c.start();
  t.after(() => c.stop());
  await publish(c.url, await fetchHistory(b.url, ada.id));
  await publish(c.url, [ada.post({ kind: 'note', text: 'continuing here' })]);
  assert.equal(c.store.heads()[ada.id], 3);

  const forged = { ...ada.log[1], body: { ...ada.log[1].body, text: 'forged' } };
  await assert.rejects(publish(c.url, [forged]), /id does not match/);
});
