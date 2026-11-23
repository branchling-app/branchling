// Sealed files for the almanac branch: only the person's own devices can open them.
//
// Format "BLA1": magic (4) · ephemeral X25519 public key (32) · nonce (12) · ChaCha20-Poly1305 ciphertext + tag (16).
// Key: HKDF-SHA256(X25519(ephemeral, recipient), salt = ephemeral ‖ recipient, info = "branchling almanac v1", 32 bytes).
// The same format is opened by CryptoKit on the iPhone and Mac and written by Node's crypto in cloud sessions.
// The plugin engine offers no ciphers (only crypto.subtle.digest), so X25519 and ChaCha20-Poly1305 are written here
// from RFC 7748 and RFC 8439; seal.test.ts checks them against the RFC test vectors.

const MAGIC = new Uint8Array([0x42, 0x4c, 0x41, 0x31]) // "BLA1"
const INFO = new TextEncoder().encode('branchling almanac v1')

// ---------- X25519 (RFC 7748) ----------

const P = (1n << 255n) - 19n
const A24 = 121665n
const mod = (a: bigint) => {
  const r = a % P
  return r < 0n ? r + P : r
}
function pow(b: bigint, e: bigint): bigint {
  let r = 1n
  b = mod(b)
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return r
}
const toBig = (b: Uint8Array) => {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}
const fromBig = (n: bigint, len = 32) => {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = Uint8Array.from(scalar)
  k[0] &= 248
  k[31] &= 127
  k[31] |= 64
  const uu = Uint8Array.from(u)
  uu[31] &= 127
  const n = toBig(k)
  const x1 = mod(toBig(uu))
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n
  for (let t = 254n; t >= 0n; t--) {
    const kt = (n >> t) & 1n
    swap ^= kt
    if (swap) [x2, x3, z2, z3] = [x3, x2, z3, z2]
    swap = kt
    const A = mod(x2 + z2), AA = mod(A * A), B = mod(x2 - z2), BB = mod(B * B), E = mod(AA - BB)
    const C = mod(x3 + z3), D = mod(x3 - z3), DA = mod(D * A), CB = mod(C * B)
    x3 = mod((DA + CB) ** 2n)
    z3 = mod(x1 * mod((DA - CB) ** 2n))
    x2 = mod(AA * BB)
    z2 = mod(E * (AA + A24 * E))
  }
  if (swap) [x2, z2] = [x3, z3]
  return fromBig(mod(x2 * pow(z2, P - 2n)))
}

const BASE = (() => {
  const b = new Uint8Array(32)
  b[0] = 9
  return b
})()
export const publicKey = (priv: Uint8Array) => x25519(priv, BASE)

// ---------- SHA-256 / HMAC / HKDF ----------

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

export async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  let k = key.length > 64 ? await sha256(key) : key
  const block = new Uint8Array(64)
  block.set(k)
  const ipad = block.map(b => b ^ 0x36), opad = block.map(b => b ^ 0x5c)
  return sha256(cat(opad, await sha256(cat(ipad, msg))))
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const prk = await hmac(salt.length ? salt : new Uint8Array(32), ikm)
  let t = new Uint8Array(0)
  const out: Uint8Array[] = []
  for (let i = 1; out.reduce((s, p) => s + p.length, 0) < len; i++) {
    t = await hmac(prk, cat(t, info, new Uint8Array([i])))
    out.push(t)
  }
  return cat(...out).slice(0, len)
}

// ---------- ChaCha20-Poly1305 (RFC 8439) ----------

const rotl = (v: number, c: number) => ((v << c) | (v >>> (32 - c))) >>> 0
function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
  const kv = dv(key), nv = dv(nonce)
  const s = new Uint32Array(16)
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574
  for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true)
  s[12] = counter >>> 0
  for (let i = 0; i < 3; i++) s[13 + i] = nv.getUint32(i * 4, true)
  const x = Uint32Array.from(s)
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16)
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12)
    x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8)
    x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7)
  }
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
  }
  const out = new Uint8Array(64), ov = dv(out)
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (x[i] + s[i]) >>> 0, true)
  return out
}

export function chacha20(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let off = 0, c = counter; off < data.length; off += 64, c++) {
    const ks = chachaBlock(key, c, nonce)
    for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i]
  }
  return out
}

export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = toBig(key.slice(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn
  const s = toBig(key.slice(16, 32))
  const p = (1n << 130n) - 5n
  let acc = 0n
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.slice(i, i + 16)
    const n = toBig(cat(chunk, new Uint8Array([1])))
    acc = ((acc + n) * r) % p
  }
  return fromBig((acc + s) & ((1n << 128n) - 1n), 16)
}

const pad16 = (n: number) => new Uint8Array((16 - (n % 16)) % 16)
const le64 = (n: number) => fromBig(BigInt(n), 8)

function aeadTag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const otk = chachaBlock(key, 0, nonce).slice(0, 32)
  return poly1305(otk, cat(aad, pad16(aad.length), ct, pad16(ct.length), le64(aad.length), le64(ct.length)))
}

export function aeadSeal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad = new Uint8Array(0)): Uint8Array {
  const ct = chacha20(key, 1, nonce, plain)
  return cat(ct, aeadTag(key, nonce, aad, ct))
}

export function aeadOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad = new Uint8Array(0)): Uint8Array | null {
  if (sealed.length < 16) return null
  const ct = sealed.slice(0, sealed.length - 16), tag = sealed.slice(sealed.length - 16)
  const want = aeadTag(key, nonce, aad, ct)
  let diff = 0
  for (let i = 0; i < 16; i++) diff |= want[i] ^ tag[i]
  return diff === 0 ? chacha20(key, 1, nonce, ct) : null
}

// ---------- The almanac file ----------

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** Seals one file for the holder of `recipient`'s private key. */
export async function seal(recipient: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const eph = random(32)
  const ephPub = publicKey(eph)
  const key = await hkdf(x25519(eph, recipient), cat(ephPub, recipient), INFO, 32)
  const nonce = random(12)
  return cat(MAGIC, ephPub, nonce, aeadSeal(key, nonce, plain))
}

/** Opens a sealed file with the private key (tests; the apps open with CryptoKit). */
export async function open(priv: Uint8Array, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < 64 || MAGIC.some((b, i) => sealed[i] !== b)) return null
  const ephPub = sealed.slice(4, 36), nonce = sealed.slice(36, 48)
  const key = await hkdf(x25519(priv, ephPub), cat(ephPub, publicKey(priv)), INFO, 32)
  return aeadOpen(key, nonce, sealed.slice(48))
}

export const toBase64 = (b: Uint8Array) => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
