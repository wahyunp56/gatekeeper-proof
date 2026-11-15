// Shared helpers: field-element conversion + keccak.
// BN128 (alt_bn128) prime field — the field of the Agent Games gatekeeper circuit.
const { keccak_256 } = require('js-sha3');

const FIELD_PRIME = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

function toField(x) {
  // x: hex string (0x..), decimal string, number, or BigInt -> field element (BigInt, mod p)
  let b;
  if (typeof x === 'bigint') b = x;
  else if (typeof x === 'number') b = BigInt(x);
  else if (typeof x === 'string' && x.startsWith('0x')) b = BigInt(x);
  else b = BigInt(x);
  const r = b % FIELD_PRIME;
  return r < 0n ? r + FIELD_PRIME : r;
}

// Hex-first conversion for hashes/salts pasted as bare hex (e.g. from
// `openssl rand -hex 16`) or 0x-prefixed. A bare hex string is NOT a valid
// decimal, so plain BigInt() would throw on a-f digits.
function toFieldHex(x) {
  if (typeof x === 'string' && !x.startsWith('0x') && /^[0-9a-fA-F]+$/.test(x)) {
    return toField(BigInt('0x' + x));
  }
  return toField(x);
}

// Normalize a hex value to a 0x-prefixed string (for snarkjs inputs, which
// only understand 0x-hex or decimal strings).
function toHexString(x) {
  const s = String(x || '');
  if (s.startsWith('0x')) return s;
  if (/^[0-9a-fA-F]+$/.test(s)) return '0x' + s;
  return s;
}

function to32Bytes(x) {
  // Field element -> 32-byte big-endian Buffer (for ABI packing / keccak input).
  const b = toField(x);
  return Buffer.from(b.toString(16).padStart(64, '0'), 'hex');
}

function keccak256Hex(buffers) {
  return '0x' + keccak_256(Buffer.concat(buffers));
}

function keccak256ModP(buffers) {
  return toField(BigInt(keccak256Hex(buffers)));
}

module.exports = { FIELD_PRIME, toField, toFieldHex, toHexString, to32Bytes, keccak256Hex, keccak256ModP };
