// Headless portal engine — runs the live index.html inside a sandboxed VM so
// every number the MCP reports is computed by the portal's own code. Zero drift.
import vm from 'node:vm';
import fs from 'node:fs';

// raw.githubusercontent serves the deployed main branch with a ~5-min edge TTL and
// honours revalidation — unlike GitHub Pages (Fastly, max-age=600, ignores no-cache),
// which can serve up-to-15-min-stale portal code after a deploy.
const PORTAL_HTML_URL = process.env.PORTAL_HTML_URL || 'https://raw.githubusercontent.com/joinindexed/indexed-fpa/main/index.html';
const PORTAL_HTML_PATH = process.env.PORTAL_HTML_PATH || null;
const HTML_CACHE_MS = parseInt(process.env.HTML_CACHE_MS || '60000', 10);

let _htmlCache = { text: null, at: 0 };

export async function loadPortalHtml() {
  const now = Date.now();
  if (_htmlCache.text && now - _htmlCache.at < HTML_CACHE_MS) return _htmlCache.text;
  if (PORTAL_HTML_PATH) {
    _htmlCache = { text: fs.readFileSync(PORTAL_HTML_PATH, 'utf8'), at: now };
    return _htmlCache.text;
  }
  try {
    const res = await fetch(PORTAL_HTML_URL, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _htmlCache = { text: await res.text(), at: now };
    return _htmlCache.text;
  } catch (e) {
    // A transient fetch failure must not brick every tool — serve the last good copy
    // if we have one, and leave _htmlCache.at so the next call retries the network.
    if (_htmlCache.text) {
      console.warn(`portal HTML refetch failed (${e.message}); serving cached copy`);
      return _htmlCache.text;
    }
    throw new Error(`Failed to fetch portal HTML and no cached copy exists: ${e.message}`);
  }
}

// Pull SB_URL / SB_KEY straight out of the portal source so the server needs no env vars.
export async function portalSupabaseConfig() {
  const html = await loadPortalHtml();
  const url = /const\s+SB_URL\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1];
  const key = /const\s+SB_KEY\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1];
  return { url, key };
}

function extractScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  if (!out.length) throw new Error('No inline <script> found in portal HTML');
  return out.join('\n;\n');
}

// A value that absorbs any DOM-ish interaction: property gets return more
// absorbers, sets are stored, calls return absorbers, string coercion is ''.
function absorber() {
  const store = Object.create(null);
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive || p === 'toString' || p === 'valueOf') return () => '';
      if (p === Symbol.iterator) return function* () {};
      if (p === 'then') return undefined; // never look like a promise
      if (p in store) return store[p];
      return absorber();
    },
    set(_t, p, v) { store[p] = v; return true; },
    apply() { return absorber(); },
    has() { return true; },
    deleteProperty(_t, p) { delete store[p]; return true; },
    // Report every property as a configurable own value so the has/delete/defineProperty
    // Proxy invariants are always satisfiable — the target function's own non-configurable
    // props (prototype, length, name) would otherwise make delete/defineProperty throw.
    getOwnPropertyDescriptor(_t, p) {
      return { configurable: true, enumerable: false, writable: true, value: p in store ? store[p] : absorber() };
    },
    defineProperty(_t, p, desc) { if ('value' in desc) store[p] = desc.value; return true; },
  });
}

function makeFakeLocalStorage(seedObj) {
  const map = new Map(Object.entries(seedObj));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

const blockedFetch = () => Promise.resolve({
  ok: false, status: 0,
  json: async () => null,
  text: async () => '',
});

// Seed keys: Supabase column -> localStorage key the portal reads at init.
const SEED_KEYS = ['ar_fcst', 'ap_fcst', 'ct_map', 'gl_mappings', 'cf_tx_overrides', 'cf_net_overrides', 'actuals_snap'];

export async function hydrate(cloudRow) {
  const html = await loadPortalHtml();
  const src = extractScripts(html);

  const seed = {};
  for (const k of SEED_KEYS) {
    const v = cloudRow?.[k];
    if (v !== null && v !== undefined) seed[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  const localStorage = makeFakeLocalStorage(seed);

  const documentStub = absorber();
  const sandbox = {
    document: documentStub,
    localStorage,
    fetch: blockedFetch,
    alert: () => {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {}, removeEventListener: () => {},
    navigator: { userAgent: 'indexed-fpa-mcp-headless' },
    location: { href: PORTAL_HTML_URL, search: '', hash: '', reload: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    FileReader: function () { return absorber(); },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  try {
    new vm.Script(src, { filename: 'portal-index.html.js' }).runInContext(sandbox, { timeout: 15000 });
  } catch (e) {
    throw new Error(`Portal script failed to initialize: ${e.message}`);
  }

  // Contract check: fail loudly with a clear message if a deploy renamed/removed the
  // functions the tools call, instead of every tool throwing an opaque ReferenceError.
  const CONTRACT = ['getD', 'buildCFGroups', 'buildFcastCFGroups', 'recalcARRow', 'recalcAPRow',
    'recomputeFcstMonths', 'getFounderPayments', 'getDecClosingBalance', 'getFcastInflow',
    'getPL', 'getBSMetrics', 'getMergedMap', 'AR_FCST', 'AP_FCST', 'E', 'FCST_MONTHS'];
  const missing = CONTRACT.filter(name => {
    try { return vm.runInContext(`typeof ${name}==='undefined'`, sandbox); } catch { return true; }
  });
  if (missing.length) {
    throw new Error(`Portal contract mismatch — the deployed index.html no longer exposes: ${missing.join(', ')}. The MCP server needs updating to match the portal.`);
  }

  const api = {
    // Run arbitrary code in the portal realm (sees top-level let/const bindings).
    run(code) {
      return vm.runInContext(code, sandbox, { timeout: 15000 });
    },
    // Evaluate an expression and return it as a plain JSON value.
    get(expr) {
      const s = api.run(`JSON.stringify((${expr}) ?? null)`);
      return s === undefined ? null : JSON.parse(s);
    },
    // Call a portal function with JSON-serializable args.
    call(fnName, ...args) {
      return api.get(`${fnName}(${args.map(a => JSON.stringify(a)).join(',')})`);
    },
    // Set the active entity and re-run CF render so cached values (_cfDecClose,
    // _cfInGroups, ...) reflect it — exactly what the browser does.
    setEntity(entity) {
      const e = ['conso', 'bh', 'bc'].includes(entity) ? entity : 'conso';
      api.run(`ent=${JSON.stringify(e)}; try{recomputeFcstMonths()}catch(_){}; try{renderCF()}catch(_){};`);
      return e;
    },
    // Read a value the portal wrote to its (fake) localStorage, JSON-parsed.
    readStore(key) {
      const v = localStorage.getItem(key);
      return v == null ? null : JSON.parse(v);
    },
    sandbox,
  };
  return api;
}
