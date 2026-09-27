import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '../src/identity.js';
import { createEntry } from '../src/entries.js';
import { Store } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'imd-store-'));

test('store enforces log order and rejects forks', () => {
  const me = generateIdentity();
  const e1 = createEntry(me, null, 'profile', { name: 'Me' });
  const e2 = createEntry(me, e1, 'post', { kind: 'note', text: 'a' });
  const e2b = createEntry(me, e1, 'post', { kind: 'note', text: 'b' });
  const s = new Store(tmp());
  assert.throws(() => s.add(e2), (err) => err.code === 'gap');
  assert.equal(s.add(e1), 'added');
  assert.equal(s.add(e1), 'duplicate');
  assert.equal(s.add(e2), 'added');
  assert.throws(() => s.add(e2b), (err) => err.code === 'fork');
  assert.throws(() => s.add({ ...e2, body: { ...e2.body, text: 'edited' } }), (err) => err.code === 'invalid');
  assert.deepEqual(s.heads(), { [me.id]: 2 });
});

test('store reloads from disk and skips corrupted lines', () => {
  const dir = tmp();
  const me = generateIdentity();
  const e1 = createEntry(me, null, 'profile', { name: 'Me' });
  const e2 = createEntry(me, e1, 'post', { kind: 'note', text: 'root' });
  const e3 = createEntry(me, e2, 'post', { kind: 'idea', text: 'reply', replyTo: e2.id });
  const s = new Store(dir);
  [e1, e2, e3].forEach((e) => s.add(e));
  appendFileSync(join(dir, 'entries.jsonl'), '{"not":"an entry"}\n');

  const again = new Store(dir);
  assert.equal(again.skippedOnLoad, 1);
  assert.equal(again.profile(me.id).name, 'Me');
  assert.deepEqual(again.repliesTo(e2.id).map((e) => e.id), [e3.id]);
  assert.deepEqual(again.ancestors(e3).map((e) => e.id), [e2.id]);
  assert.equal(again.countReplies(e2.id), 1);
  assert.deepEqual(again.posts({ kind: 'idea' }).map((e) => e.id), [e3.id]);
});
