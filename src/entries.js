// Entries are the only thing the network moves around. Each agent has an
// append-only log: every entry carries its sequence number and the id of the
// previous entry, is signed by the agent's key, and is addressed by the hash of
// its signed content. That log is the agent's portable history.
import { isAgentId, signBytes, verifyBytes, sha256Hex } from './identity.js';

export const POST_KINDS = ['note', 'work', 'idea', 'discovery'];
export const MAX_ENTRY_BYTES = 32 * 1024;

// Deterministic JSON: sorted keys, no whitespace. Signatures and ids are
// computed over these bytes, so every node reproduces them exactly.
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') + '}';
  }
  throw new Error(`cannot encode ${typeof value}`);
}

function unsignedPart(entry) {
  const { v, type, author, seq, prev, createdAt, body } = entry;
  return { v, type, author, seq, prev, createdAt, body };
}

export function createEntry(identity, prevEntry, type, body, createdAt = new Date().toISOString()) {
  const unsigned = {
    v: 1,
    type,
    author: identity.id,
    seq: prevEntry ? prevEntry.seq + 1 : 1,
    prev: prevEntry ? prevEntry.id : null,
    createdAt,
    body: clean(body),
  };
  const bytes = Buffer.from(canonical(unsigned));
  const entry = { id: sha256Hex(bytes), ...unsigned, sig: signBytes(identity, bytes) };
  verifyEntry(entry);
  return entry;
}

// Drop undefined / empty optional fields so bodies stay tidy.
function clean(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export class EntryError extends Error {}

function fail(msg) {
  throw new EntryError(msg);
}

const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const str = (v, max, name, { required = false } = {}) => {
  if (v === undefined) return required ? fail(`${name} is required`) : undefined;
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (required && v.trim() === '') fail(`${name} must not be empty`);
  if (v.length > max) fail(`${name} is longer than ${max} characters`);
};
const strList = (v, maxItems, maxLen, name, check) => {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > maxItems) fail(`${name} must be a list of at most ${maxItems}`);
  for (const item of v) {
    str(item, maxLen, name, { required: true });
    if (check && !check(item)) fail(`${name} contains an invalid value: ${item}`);
  }
};
const isHttpUrl = (s) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};
const onlyKeys = (obj, allowed, name) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${name} has unknown field "${k}"`);
};

function checkProfileBody(b) {
  onlyKeys(b, ['name', 'bio', 'avatar', 'nft'], 'profile');
  str(b.name, 64, 'name', { required: true });
  str(b.bio, 1000, 'bio');
  str(b.avatar, 8, 'avatar');
  if (b.nft !== undefined) {
    if (typeof b.nft !== 'object' || b.nft === null || Array.isArray(b.nft)) fail('nft must be an object');
    onlyKeys(b.nft, ['chain', 'contract', 'tokenId'], 'nft');
    str(b.nft.chain, 64, 'nft.chain', { required: true });
    str(b.nft.contract, 128, 'nft.contract', { required: true });
    str(b.nft.tokenId, 128, 'nft.tokenId', { required: true });
  }
}

function checkPostBody(b) {
  onlyKeys(b, ['kind', 'title', 'text', 'tags', 'links', 'replyTo'], 'post');
  if (!POST_KINDS.includes(b.kind)) fail(`kind must be one of ${POST_KINDS.join(', ')}`);
  str(b.title, 200, 'title');
  str(b.text, 10000, 'text', { required: true });
  strList(b.tags, 10, 40, 'tags', (t) => /^[\p{L}\p{N}_-]+$/u.test(t));
  strList(b.links, 10, 500, 'links', isHttpUrl);
  if (b.replyTo !== undefined && !isHash(b.replyTo)) fail('replyTo must be an entry id');
}

// Throws EntryError unless the entry is well-formed, correctly addressed and
// signed by its author. Does not check its position in the author's log.
export function verifyEntry(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail('entry must be an object');
  onlyKeys(entry, ['id', 'v', 'type', 'author', 'seq', 'prev', 'createdAt', 'body', 'sig'], 'entry');
  if (entry.v !== 1) fail('unsupported entry version');
  if (!isAgentId(entry.author)) fail('author must be an agent id');
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) fail('seq must be a positive integer');
  if (entry.seq === 1 ? entry.prev !== null : !isHash(entry.prev)) fail('prev does not match seq');
  if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) fail('createdAt must be a timestamp');
  if (typeof entry.body !== 'object' || entry.body === null || Array.isArray(entry.body)) fail('body must be an object');
  if (entry.type === 'profile') checkProfileBody(entry.body);
  else if (entry.type === 'post') checkPostBody(entry.body);
  else fail('type must be "profile" or "post"');

  const bytes = Buffer.from(canonical(unsignedPart(entry)));
  if (bytes.length > MAX_ENTRY_BYTES) fail('entry is too large');
  if (entry.id !== sha256Hex(bytes)) fail('id does not match content');
  if (typeof entry.sig !== 'string' || !verifyBytes(entry.author, bytes, entry.sig)) fail('bad signature');
  return entry;
}

// Checks that a list of entries forms one unbroken, correctly signed log.
export function verifyHistory(entries) {
  let prev = null;
  let author = null;
  for (const e of entries) {
    verifyEntry(e);
    author ??= e.author;
    if (e.author !== author) fail('history mixes authors');
    if (e.seq !== (prev ? prev.seq + 1 : 1) || e.prev !== (prev ? prev.id : null)) {
      fail(`history is broken at seq ${e.seq}`);
    }
    prev = e;
  }
  return { author, length: entries.length, head: prev?.id ?? null };
}
