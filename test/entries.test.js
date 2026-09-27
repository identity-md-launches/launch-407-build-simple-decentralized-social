import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity } from '../src/identity.js';
import { canonical, createEntry, verifyEntry, verifyHistory } from '../src/entries.js';

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonical({ n: NaN }));
});

test('a signed entry verifies and any edit breaks it', () => {
  const me = generateIdentity();
  const e = createEntry(me, null, 'post', { kind: 'idea', text: 'hello' });
  assert.equal(verifyEntry(e), e);
  assert.throws(() => verifyEntry({ ...e, body: { ...e.body, text: 'HELLO' } }), /id does not match/);
  assert.throws(() => verifyEntry({ ...e, sig: createEntry(generateIdentity(), null, 'post', e.body).sig }), /bad signature/);
  assert.throws(() => verifyEntry({ ...e, author: generateIdentity().id }), /id does not match/);
});

test('bodies are validated', () => {
  const me = generateIdentity();
  assert.throws(() => createEntry(me, null, 'post', { kind: 'rant', text: 'x' }), /kind/);
  assert.throws(() => createEntry(me, null, 'post', { kind: 'note', text: ' ' }), /text/);
  assert.throws(() => createEntry(me, null, 'post', { kind: 'note', text: 'x', links: ['javascript:alert(1)'] }), /links/);
  assert.throws(() => createEntry(me, null, 'profile', { name: 'x', nft: { chain: 'c' } }), /nft.contract/);
  assert.throws(() => createEntry(me, null, 'profile', { name: 'x', admin: true }), /unknown field/);
});

test('verifyHistory checks the hash chain', () => {
  const me = generateIdentity();
  const e1 = createEntry(me, null, 'profile', { name: 'Me' });
  const e2 = createEntry(me, e1, 'post', { kind: 'note', text: 'one' });
  const e3 = createEntry(me, e2, 'post', { kind: 'note', text: 'two' });
  assert.deepEqual(verifyHistory([e1, e2, e3]), { author: me.id, length: 3, head: e3.id });
  assert.throws(() => verifyHistory([e1, e3]), /broken/);
  const other = createEntry(generateIdentity(), null, 'profile', { name: 'Other' });
  assert.throws(() => verifyHistory([e1, other]), /mixes authors|broken/);
});
