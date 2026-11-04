// The sync relay. It stores encrypted bundles for a "sync space" and hands them back; it can't
// read them, because every bundle is encrypted on the device with a key the server never sees.
//
// Layout for one space (all keys under v/<space>/):
//   auth                  SHA-256 of the space's access token
//   usage                 rough bytes stored, for the size cap
//   log/<time>-<rand>-<n>/<i>    change bundles, in n parts
//   snap/<time>-<rand>-<n>/<i>   full snapshots, so new devices don't replay every bundle
//   blob/<id>/<i> and blob/<id>/meta   receipts, in parts
//
// Written against a tiny storage interface so it runs on Netlify Blobs in production and in
// memory in tests.

export interface BlobStorage {
  get(key: string): Promise<ArrayBuffer | null>;
  set(key: string, data: ArrayBuffer | string, opts?: { onlyIfNew?: boolean }): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const MAX_PART = 5 * 1024 * 1024;
export const MAX_SPACE = 500 * 1024 * 1024;
const SPACE_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const BUNDLE_RE = /^(log|snap)\/\d{15}-[a-z0-9]{8}-\d{1,4}$/;
const BLOB_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

function headers(origin: string | null, allowed: string[]): Record<string, string> {
  const allow = allowed.includes('*') ? '*' : origin && allowed.includes(origin) ? origin : allowed[0] ?? '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Marlow-License',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

function rand(n: number): string {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}

const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

export async function handleSync(req: Request, storage: BlobStorage, opts: { allowedOrigins?: string[]; now?: () => number; maxSpacesPerHour?: number; verifyLicense?: (code: string) => Promise<boolean> } = {}): Promise<Response> {
  const h = headers(req.headers.get('Origin'), opts.allowedOrigins ?? ['*']);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });
  const fail = (status: number, error: string, message: string) => json(status, { error, message });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k) ?? '';
  const op = q('op');
  const space = q('space');
  if (!SPACE_RE.test(space)) return fail(400, 'bad-space', 'That pairing code isn’t valid.');
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!TOKEN_RE.test(token)) return fail(401, 'no-token', 'Missing access token.');
  const root = `v/${space}/`;
  const tokenHash = await sha256Hex(token);
  const now = opts.now ?? Date.now;

  const body = async (): Promise<ArrayBuffer | Response> => {
    const len = Number(req.headers.get('Content-Length') ?? '0');
    if (len > MAX_PART) return fail(413, 'too-big', 'That part is too large.');
    const b = await req.arrayBuffer();
    if (b.byteLength > MAX_PART) return fail(413, 'too-big', 'That part is too large.');
    return b;
  };
  const addUsage = async (bytes: number): Promise<Response | null> => {
    const u = await storage.get(root + 'usage');
    const used = u ? Number(text(u)) || 0 : 0;
    if (bytes > 0 && used + bytes > MAX_SPACE) return fail(413, 'space-full', 'This sync space is full. Remove old receipts or start a new space.');
    await storage.set(root + 'usage', String(Math.max(0, used + bytes)));
    return null;
  };

  // Create the space, or confirm the token for an existing one.
  const auth = await storage.get(root + 'auth');
  if (op === 'init') {
    if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
    if (auth) return text(auth) === tokenHash ? json(200, { created: false }) : fail(403, 'wrong-passphrase', 'That passphrase doesn’t match this sync space.');
    // Only buyers create spaces: the device sends its unlock code, checked with the public key.
    if (opts.verifyLicense) {
      const code = req.headers.get('X-Marlow-License') ?? '';
      if (!code || code.length > 400 || !(await opts.verifyLicense(code))) return fail(402, 'needs-unlock', 'Sync is part of the full version. Enter your unlock code in Settings first.');
    }
    // At most a few new spaces an hour from one address, so nobody can fill the storage with empty spaces.
    const ip = req.headers.get('x-nf-client-connection-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
    if (ip) {
      const rk = `rl/init/${(await sha256Hex(ip)).slice(0, 24)}/${Math.floor(now() / 3600_000)}`;
      const count = Number(text((await storage.get(rk)) ?? new ArrayBuffer(0))) || 0;
      if (count >= (opts.maxSpacesPerHour ?? 5)) return fail(429, 'slow-down', 'Too many new sync spaces from this connection. Try again in an hour.');
      await storage.set(rk, String(count + 1));
    }
    const created = await storage.set(root + 'auth', tokenHash, { onlyIfNew: true });
    if (!created) {
      const again = await storage.get(root + 'auth');
      return again && text(again) === tokenHash ? json(200, { created: false }) : fail(403, 'wrong-passphrase', 'That passphrase doesn’t match this sync space.');
    }
    await storage.set(root + 'usage', '0');
    return json(201, { created: true });
  }
  if (!auth) return fail(404, 'no-space', 'This sync space doesn’t exist, or was deleted.');
  if (text(auth) !== tokenHash) return fail(403, 'wrong-passphrase', 'That passphrase doesn’t match this sync space.');

  switch (op) {
    case 'list': {
      const keys = await storage.list(root);
      const rel = keys.map((k) => k.slice(root.length));
      const bundles = (kind: string) => rel.filter((k) => k.startsWith(kind + '/') && k.endsWith('/0')).map((k) => k.slice(0, -2)).filter((k) => BUNDLE_RE.test(k)).sort();
      const blobs = rel.filter((k) => /^blob\/[^/]+\/meta$/.test(k)).map((k) => k.split('/')[1]);
      return json(200, { logs: bundles('log'), snaps: bundles('snap'), blobs });
    }
    case 'put': {
      // Start a bundle (part 0 picks the key) or add a later part to it.
      if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
      const b = await body();
      if (b instanceof Response) return b;
      let key = q('key');
      const part = Number(q('part') || '0');
      if (!key) {
        const kind = q('kind');
        const parts = Number(q('parts') || '1');
        if (kind !== 'log' && kind !== 'snap') return fail(400, 'bad-kind', 'Unknown bundle kind.');
        if (!Number.isInteger(parts) || parts < 1 || parts > 200) return fail(400, 'bad-parts', 'Bad part count.');
        if (part !== 0) return fail(400, 'bad-part', 'Start with part 0.');
        key = `${kind}/${String(now()).padStart(15, '0')}-${rand(8)}-${parts}`;
      }
      if (!BUNDLE_RE.test(key)) return fail(400, 'bad-key', 'Bad bundle key.');
      const total = Number(key.split('-').pop());
      if (!Number.isInteger(part) || part < 0 || part >= total) return fail(400, 'bad-part', 'Bad part number.');
      const prior = (await storage.get(`${root}${key}/${part}`))?.byteLength ?? 0;
      const full = await addUsage(b.byteLength - prior);
      if (full) return full;
      // Later parts are written first-to-last; readers treat a bundle as ready once every part is there.
      await storage.set(`${root}${key}/${part}`, b);
      return json(201, { key });
    }
    case 'get': {
      const key = q('key');
      const part = Number(q('part') || '0');
      if (!BUNDLE_RE.test(key) || !Number.isInteger(part) || part < 0) return fail(400, 'bad-key', 'Bad bundle key.');
      const b = await storage.get(`${root}${key}/${part}`);
      if (!b) return fail(404, 'missing', 'Not there yet.');
      return new Response(b, { status: 200, headers: { ...h, 'Content-Type': 'application/octet-stream' } });
    }
    case 'compact': {
      // Remove bundles a newer snapshot already contains. The newest snapshot always stays.
      if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
      let del: string[];
      try { del = (JSON.parse(text(await req.arrayBuffer())) as { delete: string[] }).delete; } catch { return fail(400, 'bad-json', 'Bad request.'); }
      if (!Array.isArray(del) || del.length > 2000) return fail(400, 'bad-json', 'Bad request.');
      const keys = (await storage.list(root)).map((k) => k.slice(root.length));
      const snaps = keys.filter((k) => k.startsWith('snap/') && k.endsWith('/0')).map((k) => k.slice(0, -2)).sort();
      const newest = snaps[snaps.length - 1];
      let freed = 0, n = 0;
      for (const k of del) {
        if (!BUNDLE_RE.test(k) || k === newest) continue;
        for (const part of keys.filter((x) => x.startsWith(k + '/'))) {
          const b = await storage.get(root + part);
          freed += b?.byteLength ?? 0;
          await storage.delete(root + part);
        }
        n++;
      }
      await addUsage(-freed);
      return json(200, { deleted: n });
    }
    case 'blob-put': {
      if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
      const id = q('id');
      const part = Number(q('part'));
      const parts = Number(q('parts'));
      if (!BLOB_ID_RE.test(id) || !Number.isInteger(parts) || parts < 1 || parts > 100 || !Number.isInteger(part) || part < 0 || part >= parts) return fail(400, 'bad-blob', 'Bad receipt upload.');
      const b = await body();
      if (b instanceof Response) return b;
      const prior = (await storage.get(`${root}blob/${id}/${part}`))?.byteLength ?? 0;
      const full = await addUsage(b.byteLength - prior);
      if (full) return full;
      await storage.set(`${root}blob/${id}/${part}`, b);
      // Parts are sent in order, so the last one marks the receipt complete.
      if (part === parts - 1) await storage.set(`${root}blob/${id}/meta`, JSON.stringify({ parts }));
      return json(201, { ok: true });
    }
    case 'blob-get': {
      const id = q('id');
      const part = Number(q('part') || '0');
      if (!BLOB_ID_RE.test(id) || !Number.isInteger(part) || part < 0) return fail(400, 'bad-blob', 'Bad receipt id.');
      if (q('meta')) {
        const m = await storage.get(`${root}blob/${id}/meta`);
        return m ? json(200, JSON.parse(text(m))) : fail(404, 'missing', 'Not there.');
      }
      const b = await storage.get(`${root}blob/${id}/${part}`);
      if (!b) return fail(404, 'missing', 'Not there.');
      return new Response(b, { status: 200, headers: { ...h, 'Content-Type': 'application/octet-stream' } });
    }
    case 'blob-delete': {
      if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
      const id = q('id');
      if (!BLOB_ID_RE.test(id)) return fail(400, 'bad-blob', 'Bad receipt id.');
      let freed = 0;
      for (const k of await storage.list(`${root}blob/${id}/`)) { freed += (await storage.get(k))?.byteLength ?? 0; await storage.delete(k); }
      await addUsage(-freed);
      return json(200, { ok: true });
    }
    case 'forget': {
      // Delete the whole space. Devices keep their own data.
      if (req.method !== 'POST') return fail(405, 'method', 'Use POST.');
      for (const k of await storage.list(root)) await storage.delete(k);
      return json(200, { ok: true });
    }
    default:
      return fail(400, 'bad-op', 'Unknown request.');
  }
}

/** In-memory storage, for tests and local development. */
export function memoryStorage(): BlobStorage & { dump(): Map<string, ArrayBuffer | string> } {
  const m = new Map<string, ArrayBuffer | string>();
  return {
    async get(k) { const v = m.get(k); return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v).buffer as ArrayBuffer : v; },
    async set(k, v, o) { if (o?.onlyIfNew && m.has(k)) return false; m.set(k, typeof v === 'string' ? v : v.slice(0)); return true; },
    async delete(k) { m.delete(k); },
    async list(p) { return [...m.keys()].filter((k) => k.startsWith(p)).sort(); },
    dump: () => m,
  };
}
