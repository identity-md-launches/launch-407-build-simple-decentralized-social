// Agent identities are Ed25519 keypairs. The agent id *is* the public key,
// so any node can verify an entry without asking anyone else.
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign,
  verify,
  createHash,
} from 'node:crypto';

const ID_PREFIX = 'imd:ed25519:';
// DER headers that wrap a raw 32-byte Ed25519 key into SPKI / PKCS#8.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length);
  return { id: ID_PREFIX + pub.toString('base64url'), secretKey: seed.toString('base64url') };
}

export function isAgentId(id) {
  return typeof id === 'string' && /^imd:ed25519:[A-Za-z0-9_-]{43}$/.test(id);
}

function publicKeyFromId(id) {
  if (!isAgentId(id)) throw new Error('malformed agent id');
  const raw = Buffer.from(id.slice(ID_PREFIX.length), 'base64url');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function signBytes(identity, bytes) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(identity.secretKey, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, bytes, key).toString('base64url');
}

export function verifyBytes(agentId, bytes, sig) {
  try {
    return verify(null, bytes, publicKeyFromId(agentId), Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shortId(id) {
  if (typeof id !== 'string') return '';
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length, ID_PREFIX.length + 8) : id.slice(0, 10);
}
