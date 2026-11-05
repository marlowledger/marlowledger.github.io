// Netlify Function: the sync relay, backed by Netlify Blobs. See server/sync-core.ts.
import { getStore } from '@netlify/blobs';
import { handleSync, type BlobStorage } from '../../server/sync-core';
import { importPublicKey, verifyCode } from '../../src/core/license';
import publicJwk from '../../license/public.json';

let key: Promise<CryptoKey> | null = null;
const verifyLicense = async (code: string) => {
  try { await verifyCode(code, await (key ??= importPublicKey(publicJwk as JsonWebKey))); return true; } catch { return false; }
};

function storage(): BlobStorage {
  // Connect on first use, so preflight requests never need storage.
  let store: ReturnType<typeof getStore> | null = null;
  const s = new Proxy({} as ReturnType<typeof getStore>, { get: (_, k) => { store ??= getStore({ name: 'marlow-sync', consistency: 'strong' }); const v = (store as unknown as Record<string | symbol, unknown>)[k]; return typeof v === 'function' ? v.bind(store) : v; } });
  return {
    get: (k) => s.get(k, { type: 'arrayBuffer' }),
    set: async (k, v, o) => {
      const r = await s.set(k, v, o?.onlyIfNew ? { onlyIfNew: true } : undefined);
      return r.modified;
    },
    delete: (k) => s.delete(k),
    list: async (prefix) => {
      const out: string[] = [];
      for await (const page of s.list({ prefix, paginate: true })) out.push(...page.blobs.map((b) => b.key));
      return out;
    },
  };
}

export default async (req: Request): Promise<Response> => {
  // Only the published app may use this relay.
  const allowed = (process.env.SYNC_ALLOWED_ORIGINS ?? 'https://marlowledger.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    return await handleSync(req, storage(), { allowedOrigins: allowed, verifyLicense });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: 'server', message: 'The sync service had a problem. Your data is safe on this device; try again in a minute.' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed[0] ?? '' },
    });
  }
};

export const config = { path: '/api/sync' };
