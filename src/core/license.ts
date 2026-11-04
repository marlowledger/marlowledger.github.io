// Unlock codes. Each Etsy order gets a code signed with the seller's private key (ECDSA P-256).
// The app holds only the public key, so it can check a code offline but never make one.
//
// Code: "ML1." + base64url(payload) + "." + base64url(signature)
// Payload: "1|<order>|<issued YYYY-MM-DD>"

export interface License {
  order: string;
  issued: string;
  code: string;
}

export const CODE_PREFIX = 'ML1';

const b64url = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
    try {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  },
};

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, ALG, false, ['verify']);
}

export function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALG, false, ['sign']);
}

/** Tidy what people paste: spaces, line breaks, a whole link, or quotes around it. */
export function cleanCode(input: string): string {
  let s = input.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  const m = s.match(/[?&#]unlock=([^&#\s]+)/);
  if (m) s = decodeURIComponent(m[1]);
  return s.replace(/\s+/g, '');
}

export class CodeError extends Error {}

/** Check a code against the public key. Returns the license, or throws a CodeError saying what's wrong. */
export async function verifyCode(input: string, publicKey: CryptoKey): Promise<License> {
  const code = cleanCode(input);
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) throw new CodeError('That isn’t a Marlow Ledger unlock code. It starts with ML1 and came in your Etsy order message.');
  const payload = b64url.decode(parts[1]);
  const sig = b64url.decode(parts[2]);
  if (!payload || !sig || sig.length !== 64) throw new CodeError('That code looks incomplete. Copy it again from your Etsy message, all in one piece.');
  const ok = await crypto.subtle.verify(SIGN, publicKey, sig, payload).catch(() => false);
  if (!ok) throw new CodeError('That code doesn’t check out. Copy it again from your Etsy message, or message the shop for help.');
  const [v, order, issued] = new TextDecoder().decode(payload).split('|');
  if (v !== '1' || !order || !/^\d{4}-\d{2}-\d{2}$/.test(issued ?? '')) throw new CodeError('That code is from a version this app doesn’t know. Message the shop for help.');
  return { order, issued, code };
}

/** Make a code (seller side). */
export async function signCode(order: string, issued: string, privateKey: CryptoKey): Promise<string> {
  const o = order.trim();
  if (!o || o.length > 40 || o.includes('|')) throw new CodeError('Enter the Etsy order number (up to 40 characters).');
  const payload = new TextEncoder().encode(`1|${o}|${issued}`);
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, payload));
  return `${CODE_PREFIX}.${b64url.encode(payload)}.${b64url.encode(sig)}`;
}
