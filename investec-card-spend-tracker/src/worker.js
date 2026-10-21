/* ============================================================
   Eating-out budget — Cloudflare Worker
   Serves the phone interface and owns the shared state in KV.

   Card spend is allocated here, not on the card. The card code
   sends raw facts (merchant code, name, amount, currency) and this
   Worker decides which ledger it belongs to: eating out, holiday
   or clothing. See "allocation" below.

   Identity is Cloudflare Access (Google sign-in). There is no
   passphrase. The Worker verifies the Access JWT itself rather
   than trusting that Access is in front of it. Any Google account
   works, Gmail or Google Workspace. The Worker only needs the
   signed token to carry an email address, so another identity
   provider that supplies one would work too.

   Bindings required (see docs/02 and docs/03):
     KV namespace  STATE
     Secret        ACCESS_TEAM      your team name, the part before
                                    .cloudflareaccess.com
     Secret        ACCESS_AUD       Application Audience (AUD) tag of
                                    the Access app that protects the UI
     Secret        ALLOWED_EMAILS   comma-separated Google account
                                    addresses, e.g.
                                    alex@example.com,sam@example.com
                                    (recommended; empty = rely on the
                                    Access policy alone)
     Secret        CARD_KEY         long random string the card sends
                                    in the x-card-key header
   ============================================================ */

const STATE_KEY = 'dining-state';
const MAX_BODY = 8192;
const MAX_TXNS = 400;
const MAX_GOALS = 30;
const MAX_NAME = 60;
const MAX_POT_ENTRIES = 500;
const SNAPSHOT_DAYS = 45;
const JWKS_TTL_MS = 3600e3;

/* Accruing pots: manual logging only, no card involvement.
   A pot builds at a monthly rate from its start month and is drawn
   down by erratic once-off purchases. Accrual never resets in January
   and is uncapped — five years of an untouched pot is a real balance. */
const POTS = {
  holiday:  { label: 'Holiday',  noun: 'trip',     defaultMonthly: 2000 },
  clothing: { label: 'Clothing', noun: 'purchase', defaultMonthly: 500 }
};
const POT_KEYS = Object.keys(POTS);

const BLANK = {
  settings: { monthlyBudget: 3000, carryDeficit: true },
  months: {},
  goals: [],
  lastSnapshot: null,
  pots: {},
  rules: {}          // merchant-name fragment -> category, ahead of the MCC table
};

/* ---------- constant-time comparison (card key only) ---------- */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(ea, eb);
  }
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/* ---------- Cloudflare Access JWT verification ---------- */

let jwksCache = { at: 0, keys: null, team: null };

function b64urlBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function getJWKS(env) {
  const fresh = jwksCache.keys && jwksCache.team === env.ACCESS_TEAM &&
                Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh) return jwksCache.keys;

  const r = await fetch('https://' + env.ACCESS_TEAM + '.cloudflareaccess.com/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('jwks fetch failed');
  const { keys } = await r.json();
  jwksCache = { at: Date.now(), keys, team: env.ACCESS_TEAM };
  return keys;
}

// Returns the verified payload, or null. Never throws to the caller.
async function verifyAccess(request, env) {
  try {
    if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;

    let token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) {
      const cookie = request.headers.get('Cookie') || '';
      const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
      if (m) token = m[1];
    }
    if (!token) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64urlJson(parts[0]);
    if (header.alg !== 'RS256') return null;

    const jwk = (await getJWKS(env)).find(k => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);

    const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed);
    if (!ok) return null;

    const p = b64urlJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (!p.exp || p.exp < now) return null;
    if (p.nbf && p.nbf > now + 60) return null;
    if (p.iss !== 'https://' + env.ACCESS_TEAM + '.cloudflareaccess.com') return null;

    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;

    // Service tokens produce a valid JWT with no email (sub is empty). Only a
    // person signed in with an email may use the app, whatever ALLOWED_EMAILS
    // holds, so a token can never be mistaken for a user.
    const email = String(p.email || '').toLowerCase();
    if (!email) return null;
    const allowed = String(env.ALLOWED_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(email)) return null;

    return { email, sub: p.sub };
  } catch {
    return null;
  }
}

// Display name for the log: the part before the @, capitalised.
function shortName(email) {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!local) return 'someone';
  return local.charAt(0).toUpperCase() + local.slice(1, 20);
}

/* ---------- local time ----------
   Everything here is South African. SAST is UTC+2 with no DST, so
   shifting the clock forward two hours and then reading it as if it
   were UTC gives the local wall-clock date. Without this, the first
   two hours of every month are still filed under the previous one. */

// CUSTOMISE: this is your UTC offset in hours (2 = South African Standard Time).
// If your timezone observes daylight saving, see docs/08-customising.md.
const SAST_OFFSET_MS = 2 * 3600e3;
const sastNow = () => new Date(Date.now() + SAST_OFFSET_MS);
const todayISO = () => sastNow().toISOString().slice(0, 10);
const nowMonth = () => sastNow().toISOString().slice(0, 7);
const monthOf = iso => iso.slice(0, 7);

// 'YYYY-MM' -> a sortable integer, so month arithmetic never touches Date.
const monthIndex = k => {
  const [y, m] = k.split('-').map(Number);
  return y * 12 + (m - 1);
};

/* ---------- validation ---------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function cleanDate(v) {
  const d = typeof v === 'string' ? v.slice(0, 10) : '';
  if (!ISO_DATE.test(d)) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  const now = Date.now();
  if (t > now + 40 * 864e5) return null;
  if (t < now - 6 * 365 * 864e5) return null;
  return d;
}

function cleanAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e6) return null;
  return Math.round(n * 100) / 100;
}

const cleanText = (v, fallback) => {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (s || fallback).slice(0, MAX_NAME);
};

/* ---------- state ---------- */

async function load(env) {
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return structuredClone(BLANK);
  try {
    const s = JSON.parse(raw);
    const out = { ...structuredClone(BLANK), ...s, settings: { ...BLANK.settings, ...(s.settings || {}) } };
    if (!out.rules || typeof out.rules !== 'object' || Array.isArray(out.rules)) out.rules = {};
    return out;
  } catch {
    return structuredClone(BLANK);
  }
}

async function store(env, s) {
  const today = todayISO();
  const wantSnapshot = s.lastSnapshot !== today;
  if (wantSnapshot) s.lastSnapshot = today;
  const body = JSON.stringify(s);
  await env.STATE.put(STATE_KEY, body);
  if (wantSnapshot) await env.STATE.put('snap:' + today, body, { expirationTtl: SNAPSHOT_DAYS * 86400 });
}

function nextMonth(k) {
  const [y, m] = k.split('-').map(Number);
  return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
}

function chain(s) {
  const keys = Object.keys(s.months).sort();
  const now = nowMonth();
  let k = keys.length && keys[0] < now ? keys[0] : now;
  const rows = [];
  let carry = 0;

  for (let guard = 0; guard < 600; guard++) {
    const m = s.months[k] || {};
    const budget = m.budget != null ? m.budget : s.settings.monthlyBudget;
    const txns = m.txns || [];
    const stashed = m.stashed || 0;
    const spent = txns.reduce((a, t) => a + t.amount, 0);
    const available = budget + carry;
    const remaining = available - spent - stashed;

    rows.push({ key: k, budget, carriedIn: carry, spent, stashed, available, remaining, txns });
    carry = remaining < 0 && !s.settings.carryDeficit ? 0 : remaining;

    if (k === now) break;
    k = nextMonth(k);
  }
  return rows;
}

/* ---------- accruing pots ---------- */

function touchPot(s, key) {
  if (!s.pots || typeof s.pots !== 'object') s.pots = {};
  let p = s.pots[key];
  if (!p || typeof p !== 'object') {
    p = s.pots[key] = { rates: [], entries: [] };
  }
  if (!Array.isArray(p.entries)) p.entries = [];
  if (!Array.isArray(p.rates) || !p.rates.length) {
    // First touch: start accruing from this month at the default rate.
    p.rates = [{ from: nowMonth(), monthly: POTS[key].defaultMonthly }];
  }
  return p;
}

/* Total accrued from the first rate segment up to and including this
   month. Each segment owns the months from its own start until the
   next segment begins, so raising the monthly amount in 2027 leaves
   everything earned in 2026 untouched. */
function accrued(rates, upToMonth) {
  const end = monthIndex(upToMonth);
  const sorted = [...rates].sort((a, b) => a.from.localeCompare(b.from));
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const startI = monthIndex(sorted[i].from);
    if (startI > end) break;
    const nextI = i + 1 < sorted.length ? monthIndex(sorted[i + 1].from) - 1 : end;
    const months = Math.min(nextI, end) - startI + 1;
    if (months > 0) total += months * sorted[i].monthly;
  }
  return Math.round(total * 100) / 100;
}

function potView(s, key) {
  const p = s.pots && s.pots[key];
  const cfg = POTS[key];
  if (!p || !Array.isArray(p.rates) || !p.rates.length) {
    return {
      key, label: cfg.label, noun: cfg.noun, started: null,
      monthly: cfg.defaultMonthly, accrued: 0, spent: 0, available: 0,
      months: 0, rates: [], entries: []
    };
  }

  const cur = nowMonth();
  const rates = [...p.rates].sort((a, b) => a.from.localeCompare(b.from));
  const entries = Array.isArray(p.entries) ? p.entries : [];
  const total = accrued(rates, cur);
  const spent = Math.round(entries.reduce((a, e) => a + e.amount, 0) * 100) / 100;
  const started = rates[0].from;

  return {
    key,
    label: cfg.label,
    noun: cfg.noun,
    started,
    monthly: rates[rates.length - 1].monthly,
    accrued: total,
    spent,
    available: Math.round((total - spent) * 100) / 100,
    months: monthIndex(cur) - monthIndex(started) + 1,
    rates,
    entries: [...entries]
      .sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0))
      .map(entryOut)
  };
}

// A fault in a pot must never take down the eating-out view with it.
function potsView(s) {
  const out = {};
  for (const key of POT_KEYS) {
    try {
      out[key] = potView(s, key);
    } catch {
      const cfg = POTS[key];
      out[key] = {
        key, label: cfg.label, noun: cfg.noun, started: null,
        monthly: cfg.defaultMonthly, accrued: 0, spent: 0, available: 0,
        months: 0, rates: [], entries: [], broken: true
      };
    }
  }
  return out;
}

/* ---------- allocation: which ledger does a card spend belong in? ----------
   The card code knows nothing about categories. It reports what the
   merchant said (code, name, amount, currency) and this is the one place
   that turns that into a ledger entry, so changing the mapping never means
   redeploying the card.

   Order of precedence:
     1. a merchant rule you set      ("woolworths" -> clothing)
     2. the merchant category code table below
     3. otherwise: not tracked. Groceries, fuel and the rest are dropped,
        not stored. Log those by hand if you want them counted.

   Merchant codes are a blunt instrument (a hotel restaurant, a department
   store). That is what Move and merchant rules are for. */

const CATEGORIES = ['dining', ...POT_KEYS];
const CAT_LABEL = { dining: 'Eating out', holiday: 'Holiday', clothing: 'Clothing' };
const MAX_RULES = 50;

// Inclusive [from, to] ranges of merchant category codes.
const MCC_RANGES = {
  // 5811 caterers, 5812 restaurants, 5813 bars, 5814 fast food, 5462 bakeries
  dining: [[5811, 5814], [5462, 5462]],
  holiday: [
    [3000, 3299],                         // airlines
    [3351, 3441],                         // car rental brands
    [3501, 3838],                         // hotel and resort brands
    [4411, 4411], [4457, 4457],           // cruise lines, boat rental
    [4511, 4511], [4722, 4722],           // air carriers, travel agencies
    [7011, 7012], [7032, 7033],           // lodging, timeshares, camps, campsites
    [7512, 7512], [7519, 7519]            // car hire, motor homes
  ],
  clothing: [
    [5611, 5611], [5621, 5621], [5631, 5631], [5641, 5641], [5651, 5651],
    [5655, 5655], [5661, 5661], [5681, 5681], [5691, 5691],
    [5697, 5699]                          // tailors, wigs, misc apparel
  ]
};

const normName = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function classify(mcc, name, rules) {
  const hay = normName(name);
  let best = null;
  if (rules && typeof rules === 'object') {
    for (const [frag, cat] of Object.entries(rules)) {
      if (CATEGORIES.includes(cat) && frag && hay.includes(frag) && (!best || frag.length > best.frag.length)) {
        best = { frag, cat };            // the most specific fragment wins
      }
    }
  }
  if (best) return { category: best.cat, via: 'rule' };

  const n = Number(mcc);
  if (Number.isInteger(n)) {
    for (const cat of CATEGORIES) {
      if ((MCC_RANGES[cat] || []).some(([a, b]) => n >= a && n <= b)) return { category: cat, via: 'mcc' };
    }
  }
  return { category: null, via: 'none' };
}

/* Every entry in every ledger, tagged with the ledger it sits in. */
function* ledgerEntries(s) {
  for (const m of Object.values(s.months || {})) {
    for (const t of (m.txns || [])) yield ['dining', t];
  }
  for (const key of POT_KEYS) {
    const p = s.pots && s.pots[key];
    if (p && Array.isArray(p.entries)) for (const e of p.entries) yield [key, e];
  }
}

// What the card reported, before any rand conversion.
const face = t => (t.foreign ? t.foreign.amount : t.amount);

/* The card reference is the literal string "simulation" in the sandbox, and
   Investec does not document it as unique, so it cannot be a key. Instead a
   card purchase is a duplicate if the same merchant, day and amount was
   booked in the last two minutes, in ANY ledger. Checking every ledger
   matters: if you Move an entry and the card retries, the retry must not
   land a second copy back in the original ledger. */
function findCardDupe(s, probe) {
  for (const [, t] of ledgerEntries(s)) {
    if (t.src === 'card' && t.date === probe.date && t.name === probe.name &&
        face(t) === probe.amount && probe.at - (t.at || 0) < 120000) return true;
  }
  return false;
}

function findEntry(s, ledger, id) {
  if (ledger === 'dining') {
    for (const m of Object.values(s.months || {})) {
      const i = (m.txns || []).findIndex(t => t.id === id);
      if (i >= 0) return { list: m.txns, i, entry: m.txns[i] };
    }
    return null;
  }
  const p = s.pots && s.pots[ledger];
  if (!p || !Array.isArray(p.entries)) return null;
  const i = p.entries.findIndex(e => e.id === id);
  return i >= 0 ? { list: p.entries, i, entry: p.entries[i] } : null;
}

// Returns an error message if the target is full, otherwise null.
function placeEntry(s, ledger, entry) {
  if (ledger === 'dining') {
    const m = touchMonth(s, monthOf(entry.date));
    if (m.txns.length >= MAX_TXNS) return 'That month already has ' + MAX_TXNS + ' entries.';
    m.txns.push(entry);
  } else {
    const p = touchPot(s, ledger);
    if (p.entries.length >= MAX_POT_ENTRIES) return 'That pot already has ' + MAX_POT_ENTRIES + ' entries.';
    p.entries.push(entry);
  }
  return null;
}

// What is left in a ledger: this month's remainder, or a pot's balance.
const balanceOf = (s, ledger) =>
  ledger === 'dining' ? chain(s).pop().remaining : potView(s, ledger).available;

// The shape every list in the app receives.
const entryOut = t => ({
  id: t.id, date: t.date, name: t.name, amount: t.amount, by: t.by,
  src: t.src || 'manual', pending: !!t.pending, foreign: t.foreign || null
});

function view(s, identity) {
  const rows = chain(s);
  const cur = rows[rows.length - 1];
  const pot = Object.values(s.months).reduce((a, m) => a + (m.stashed || 0), 0);
  return {
    me: identity ? identity.email : null,
    current: {
      key: cur.key, budget: cur.budget, carriedIn: cur.carriedIn, spent: cur.spent,
      stashed: cur.stashed, available: cur.available, remaining: cur.remaining,
      txns: [...cur.txns].sort((a, b) => b.date.localeCompare(a.date))
        .map(entryOut)
    },
    pot,
    months: rows.map(({ txns, ...r }) => r).reverse(),
    goals: s.goals,
    settings: s.settings,
    pots: potsView(s),
    cats: CATEGORIES.map(key => ({ key, label: CAT_LABEL[key] })),
    rules: Object.entries(s.rules || {})
      .filter(([, cat]) => CATEGORIES.includes(cat))
      .map(([match, category]) => ({ match, category }))
      .sort((a, b) => a.match.localeCompare(b.match))
  };
}

function touchMonth(s, key) {
  if (!s.months[key]) s.months[key] = { budget: s.settings.monthlyBudget, txns: [], stashed: 0 };
  if (!s.months[key].txns) s.months[key].txns = [];
  return s.months[key];
}

/* ---------- responses ---------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }
  });

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text || '{}'); } catch { return null; }
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* --- static --- */
    if (path === '/' && request.method === 'GET') {
      const nonce = crypto.randomUUID().replace(/-/g, '');
      const csp = [
        "default-src 'none'",
        "script-src 'nonce-" + nonce + "'",
        "style-src 'nonce-" + nonce + "'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ].join('; ');
      return new Response(PAGE.replace(/__NONCE__/g, nonce), {
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Content-Security-Policy': csp,
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS
        }
      });
    }
    if (path === '/manifest.json') return json(MANIFEST);
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }
      });
    }
    if (path === '/icon.svg') {
      return new Response(ICON, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400', ...SECURITY_HEADERS }
      });
    }
    if (path === '/sw.js') {
      return new Response('self.addEventListener("fetch",function(){});', {
        headers: { 'Content-Type': 'text/javascript', ...SECURITY_HEADERS }
      });
    }

    /* --- the card posts here, with its own key --- */
    if (path === '/api/card' && request.method === 'POST') {
      if (!env.CARD_KEY || !safeEqual(request.headers.get('x-card-key') || '', env.CARD_KEY)) {
        return json({ error: 'unauthorised' }, 401);
      }
      const b = await readBody(request);
      if (!b) return json({ error: 'bad request' }, 400);

      const s = await load(env);

      // Everything below can touch the pots. A fault here must come back as a
      // plain 500 the card code can log, never as an unhandled throw.
      try {
        const name = cleanText(b.name, 'Card purchase');

        // Card code from before categories existed sent no merchant code and
        // only ever reported dining spend, so a caller with neither a code nor
        // a version marker is treated as dining. The current card code always
        // sends v:2, so a transaction missing its code is ignored, not misfiled.
        const hasCode = b.mcc !== undefined && b.mcc !== null && b.mcc !== '';
        const legacy = !hasCode && b.v == null;
        const cls = legacy ? { category: 'dining', via: 'legacy' } : classify(b.mcc, name, s.rules);
        if (!cls.category) {
          return json({ ok: true, ignored: true,
            reason: hasCode ? 'no category for merchant code ' + String(b.mcc).slice(0, 8) : 'no merchant code' });
        }

        const cur = String(b.currency || 'zar');
        if (!/^[a-z]{3}$/i.test(cur)) return json({ error: 'bad currency' }, 400);
        const foreign = cur.toLowerCase() !== 'zar';

        const amount = cleanAmount(b.amount);
        if (amount === null) return json({ error: 'bad amount' }, 400);
        const date = cleanDate(b.date) || todayISO();
        const at = Date.now();

        if (findCardDupe(s, { date, name, amount, at })) {
          return json({ ok: true, duplicate: true, category: cls.category, remaining: balanceOf(s, cls.category) });
        }

        const entry = {
          id: crypto.randomUUID(), date, name,
          amount: foreign ? 0 : amount,
          by: cleanText(b.by, 'card'), src: 'card', at
        };
        const code = Number(b.mcc);
        if (hasCode && Number.isInteger(code)) entry.mcc = code;

        // Nothing in the payload converts a foreign amount to rand, so it is
        // held as pending (counted as R0) until you confirm what it cost.
        // Counting EUR 200 as R200 would silently under-report the trip.
        if (foreign) {
          entry.pending = true;
          entry.foreign = { currency: cur.toUpperCase(), amount };
        }

        const full = placeEntry(s, cls.category, entry);
        if (full) return json({ error: full }, 409);

        await store(env, s);
        return json({
          ok: true, category: cls.category, via: cls.via,
          pending: foreign, remaining: balanceOf(s, cls.category)
        });
      } catch (err) {
        return json({ error: 'could not allocate' }, 500);
      }
    }

    /* --- everything else needs a valid Cloudflare Access identity --- */
    if (path.startsWith('/api/')) {
      // Fail closed. A missing Access config must never mean open access.
      if (!env.ACCESS_TEAM || !env.ACCESS_AUD) {
        return json({ error: 'Access is not configured on this Worker.', setup: true }, 503);
      }

      const me = await verifyAccess(request, env);
      if (!me) return json({ error: 'Not signed in.', signin: true }, 401);

      const s = await load(env);
      if (path === '/api/state' && request.method === 'GET') return json(view(s, me));
      if (request.method !== 'POST') return json({ error: 'not found' }, 404);

      const b = await readBody(request);
      if (!b) return json({ error: 'bad request' }, 400);

      // A throw in one section must not write a half-mutated state
      // object, and must not reach the card path on the next request.
      try {
      switch (path) {
        case '/api/tx': {
          const amount = cleanAmount(b.amount);
          if (amount === null) return json({ error: 'Enter an amount between 0 and 1 000 000.' }, 400);
          const date = cleanDate(b.date) || todayISO();
          const m = touchMonth(s, monthOf(date));
          if (m.txns.length >= MAX_TXNS) return json({ error: 'That month already has 400 entries.' }, 409);
          m.txns.push({
            id: crypto.randomUUID(), date, amount,
            name: cleanText(b.name, 'Eating out'),
            by: shortName(me.email),          // identity comes from the token, not the client
            src: 'manual', at: Date.now()
          });
          break;
        }
        case '/api/tx/delete': {
          if (typeof b.id !== 'string' || b.id.length > 64) return json({ error: 'bad id' }, 400);
          for (const m of Object.values(s.months)) m.txns = (m.txns || []).filter(t => t.id !== b.id);
          break;
        }
        case '/api/stash': {
          const raw = Number(b.amount);
          if (!Number.isFinite(raw)) return json({ error: 'Enter an amount.' }, 400);
          const cur = chain(s).pop();
          if (raw > 0 && raw > cur.remaining) {
            return json({ error: 'Only R' + Math.max(cur.remaining, 0).toFixed(0) + ' spare.' }, 400);
          }
          const m = touchMonth(s, nowMonth());
          m.stashed = Math.max(0, Math.min(1e7, (m.stashed || 0) + raw));
          break;
        }
        case '/api/goal': {
          if (b.remove) {
            if (typeof b.remove !== 'string' || b.remove.length > 64) return json({ error: 'bad id' }, 400);
            s.goals = s.goals.filter(g => g.id !== b.remove);
          } else {
            const amount = cleanAmount(b.amount);
            const label = cleanText(b.label, '');
            if (!label || amount === null) return json({ error: 'Needs a name and an amount.' }, 400);
            if (s.goals.length >= MAX_GOALS) return json({ error: 'That is enough splurges for now.' }, 409);
            s.goals.push({ id: crypto.randomUUID(), label, amount });
          }
          break;
        }
        case '/api/settings': {
          const budget = cleanAmount(b.monthlyBudget);
          if (budget !== null) {
            s.settings.monthlyBudget = budget;
            touchMonth(s, nowMonth()).budget = budget;
          }
          if (typeof b.carryDeficit === 'boolean') s.settings.carryDeficit = b.carryDeficit;
          break;
        }

        /* --- allocation corrections --- */

        // Merchant codes misfile things (a hotel restaurant, a department
        // store). Move re-homes any entry, card or manual, between ledgers.
        case '/api/alloc/move': {
          if (!CATEGORIES.includes(b.from) || !CATEGORIES.includes(b.to) || b.from === b.to) {
            return json({ error: 'Pick a different category to move it to.' }, 400);
          }
          if (typeof b.id !== 'string' || b.id.length > 64) return json({ error: 'bad id' }, 400);
          const hit = findEntry(s, b.from, b.id);
          if (!hit) return json({ error: 'That entry is no longer there.' }, 404);

          // Place first, remove second. An error return is never persisted, so a
          // full target cannot lose the entry either way; this just keeps the
          // in-memory state consistent while the request is still running.
          const full = placeEntry(s, b.to, { ...hit.entry });
          if (full) return json({ error: full }, 409);
          hit.list.splice(hit.i, 1);
          break;
        }

        // A foreign-currency card purchase waits at R0 until you say what it cost.
        case '/api/alloc/settle': {
          if (!CATEGORIES.includes(b.ledger)) return json({ error: 'Unknown category.' }, 400);
          if (typeof b.id !== 'string' || b.id.length > 64) return json({ error: 'bad id' }, 400);
          const amount = cleanAmount(b.amount);
          if (amount === null) return json({ error: 'Enter the rand amount.' }, 400);
          const hit = findEntry(s, b.ledger, b.id);
          if (!hit || !hit.entry.pending) return json({ error: 'Nothing is waiting on a rand amount there.' }, 404);
          hit.entry.amount = amount;
          delete hit.entry.pending;
          break;
        }

        // Add, change or (empty category) remove a merchant rule.
        case '/api/rule': {
          const frag = normName(b.match);
          if (frag.length < 3 || frag.length > 30) {
            return json({ error: 'Use 3 to 30 letters or numbers from the merchant name.' }, 400);
          }
          if (!s.rules || typeof s.rules !== 'object') s.rules = {};
          if (b.category === '' || b.category == null) {
            delete s.rules[frag];
          } else {
            if (!CATEGORIES.includes(b.category)) return json({ error: 'Unknown category.' }, 400);
            const isNew = !Object.prototype.hasOwnProperty.call(s.rules, frag);
            if (isNew && Object.keys(s.rules).length >= MAX_RULES) {
              return json({ error: 'That is enough rules for now.' }, 409);
            }
            s.rules[frag] = b.category;
          }
          break;
        }

        /* --- accruing pots: holiday and clothing --- */

        case '/api/pot/entry': {
          if (!POT_KEYS.includes(b.pot)) return json({ error: 'Unknown pot.' }, 400);
          const amount = cleanAmount(b.amount);
          if (amount === null) return json({ error: 'Enter an amount between 0 and 1 000 000.' }, 400);
          const date = cleanDate(b.date) || todayISO();
          const p = touchPot(s, b.pot);
          if (p.entries.length >= MAX_POT_ENTRIES) {
            return json({ error: 'That pot already has ' + MAX_POT_ENTRIES + ' entries.' }, 409);
          }
          p.entries.push({
            id: crypto.randomUUID(), date, amount,
            name: cleanText(b.name, POTS[b.pot].label),
            by: shortName(me.email),
            at: Date.now()
          });
          break;
        }

        case '/api/pot/entry/delete': {
          if (!POT_KEYS.includes(b.pot)) return json({ error: 'Unknown pot.' }, 400);
          if (typeof b.id !== 'string' || b.id.length > 64) return json({ error: 'bad id' }, 400);
          const p = touchPot(s, b.pot);
          p.entries = p.entries.filter(e => e.id !== b.id);
          break;
        }

        case '/api/pot/settings': {
          if (!POT_KEYS.includes(b.pot)) return json({ error: 'Unknown pot.' }, 400);
          const p = touchPot(s, b.pot);

          // Changing the rate appends a segment from this month on.
          // Past months keep whatever they were earning at the time.
          const monthly = cleanAmount(b.monthly);
          if (monthly !== null) {
            const cur = nowMonth();
            p.rates = p.rates.filter(r => r.from !== cur);
            p.rates.push({ from: cur, monthly });
            p.rates.sort((a, b2) => a.from.localeCompare(b2.from));
          }

          // Backdating the start month lets a pot claim months it was
          // already quietly building up before anyone opened the app.
          if (b.startMonth != null) {
            if (!ISO_MONTH.test(String(b.startMonth))) {
              return json({ error: 'Start month must look like 2026-01.' }, 400);
            }
            const start = String(b.startMonth);
            if (monthIndex(start) > monthIndex(nowMonth())) {
              return json({ error: 'A pot cannot start in the future.' }, 400);
            }
            if (monthIndex(start) < monthIndex(nowMonth()) - 600) {
              return json({ error: 'That start month is too far back.' }, 400);
            }
            const earliest = p.rates[0];
            p.rates = p.rates.filter(r => monthIndex(r.from) > monthIndex(start));
            p.rates.unshift({ from: start, monthly: earliest.monthly });
          }
          break;
        }
        default:
          return json({ error: 'not found' }, 404);
      }
      } catch (err) {
        // Nothing has been written yet, so the stored state is still clean.
        return json({ error: 'That did not save. Nothing was changed.' }, 500);
      }

      await store(env, s);
      return json(view(s, me));
    }

    return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
  }
};

/* ---------- static assets ---------- */

const MANIFEST = {
  name: 'Eating out',
  short_name: 'Eating out',
  start_url: '/',
  display: 'standalone',
  background_color: '#14161f',
  theme_color: '#14161f',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
};

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
  '<rect width="192" height="192" rx="42" fill="#14161f"/>' +
  '<circle cx="96" cy="96" r="46" fill="none" stroke="#e8a33d" stroke-width="9"/>' +
  '<circle cx="96" cy="96" r="20" fill="#7fa88b"/></svg>';

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#14161f">
<meta name="robots" content="noindex,nofollow">
<title>Eating out</title>
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg">
<style nonce="__NONCE__">
:root{--ink:#14161f;--slab:#1d2030;--slab2:#252940;--line:#333752;--bone:#ece8e1;--muted:#8d93aa;
--amber:#e8a33d;--sage:#7fa88b;--sage-d:#3d5646;--coral:#e06a5c;--coral-d:#6b3630;
--disp:system-ui,-apple-system,'Roboto','Segoe UI',sans-serif;
--body:system-ui,-apple-system,'Roboto','Segoe UI',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--ink);color:var(--bone);font-family:var(--body);font-variant-numeric:tabular-nums;
line-height:1.45;padding:max(16px,env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom));
max-width:560px;margin:0 auto;-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
button,input,select{font-family:inherit}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);font-weight:600}
.tabs{display:flex;gap:4px;margin-bottom:16px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{background:none;border:0;color:var(--muted);padding:10px 13px;font-size:13px;font-weight:500;
border-radius:8px;white-space:nowrap;cursor:pointer}
.tab[aria-selected=true]{background:var(--slab2);color:var(--bone)}
.tab:focus-visible,.btn:focus-visible,.x:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
.card{background:var(--slab);border:1px solid var(--line);border-radius:16px;padding:18px 16px;margin-bottom:13px}
.card h2{font-family:var(--disp);font-size:16px;font-weight:700;letter-spacing:-.01em;margin-bottom:3px}
.sub{font-size:12.5px;color:var(--muted);margin-bottom:14px}
.big{font-family:var(--disp);font-size:clamp(42px,14vw,62px);font-weight:800;letter-spacing:-.045em;line-height:1}
.big.over{color:var(--coral)}
.biglabel{font-size:13px;color:var(--muted);margin:6px 0 20px}
.bar{height:14px;border-radius:7px;background:var(--slab2);border:1px solid var(--line);overflow:hidden}
.fill{height:100%;background:var(--amber);transition:width .45s cubic-bezier(.2,.7,.3,1)}
.fill.over{background:var(--coral)}
.wrap{position:relative;margin:28px 0 8px}
.tick{position:absolute;top:-9px;bottom:-9px;width:2px;background:var(--sage)}
.ticklab{position:absolute;top:-27px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
color:var(--sage);font-weight:600;transform:translateX(-50%);white-space:nowrap}
.ends{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:8px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-radius:10px;
overflow:hidden;margin-top:20px}
.cell{background:var(--slab);padding:12px 10px}
.cell dt{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:5px}
.cell dd{font-family:var(--disp);font-size:17px;font-weight:700;letter-spacing:-.02em}
.pos{color:var(--sage)}.neg{color:var(--coral)}
.row{display:flex;gap:8px;margin-bottom:10px}.row>*{flex:1;min-width:0}
label.fl{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
font-weight:600;margin-bottom:5px}
input,select{width:100%;background:var(--ink);border:1px solid var(--line);color:var(--bone);
border-radius:9px;padding:12px;font-size:16px}
input:focus,select:focus{outline:2px solid var(--amber);outline-offset:1px;border-color:transparent}
.btn{background:var(--amber);color:#20160a;border:0;border-radius:9px;padding:13px 16px;font-size:14.5px;
font-weight:600;width:100%;cursor:pointer;min-height:46px}
.btn.ghost{background:none;border:1px solid var(--line);color:var(--bone)}
.btn:disabled{opacity:.5}
.item{display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0}
.d{flex:0 0 46px;font-size:11px;color:var(--muted);text-transform:uppercase}
.n{flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a{font-family:var(--disp);font-size:14px;font-weight:700;letter-spacing:-.02em}
.x{background:none;border:0;color:var(--muted);font-size:19px;padding:4px 6px;cursor:pointer;line-height:1;
border-radius:6px;min-width:32px}
.dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:14px;font-weight:700;flex:0 0 auto}
.yes{background:var(--sage-d);color:var(--sage)}.no{background:var(--coral-d);color:var(--coral)}
.gs{font-size:11.5px;color:var(--muted);margin-top:2px;white-space:normal}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:right;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
font-weight:600;padding:0 0 8px}
th:first-child,td:first-child{text-align:left}
td{text-align:right;padding:9px 0;border-top:1px solid var(--line);white-space:nowrap}
.empty{color:var(--muted);font-size:13px;padding:16px 0;text-align:center}
.flash{border-radius:9px;padding:10px 12px;font-size:13px;margin-bottom:12px;background:var(--sage-d);color:var(--sage)}
.flash.warn{background:var(--coral-d);color:var(--coral)}
.mv{flex:0 0 auto;width:48px;padding:6px 4px;font-size:16px;border-radius:7px;background:var(--slab2);color:var(--muted);text-align:center}
.btn.sm{width:auto;min-height:32px;padding:5px 10px;font-size:12px}
.hide{display:none!important}
.gate{padding:56px 4px}
.note{font-size:12px;color:var(--muted);margin-top:10px}
.tag{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:1px 5px;
white-space:nowrap;vertical-align:1px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<div id="gate" class="gate">
  <h2 style="font-family:var(--disp);font-size:23px;font-weight:800;letter-spacing:-.03em;margin-bottom:6px">Eating out</h2>
  <p class="sub" id="gateMsg">Checking your Google sign-in&hellip;</p>
  <button class="btn hide" id="signIn">Sign in with Google</button>
  <p class="note hide" id="gateHelp">Access will ask for your Google account. Only the addresses on the allow list can get in.</p>
</div>

<div id="app" class="hide">
  <div class="tabs" role="tablist">
    <button class="tab" data-t="now" aria-selected="true">This month</button>
    <button class="tab" data-t="log" aria-selected="false">Log</button>
    <button class="tab" data-t="months" aria-selected="false">Months</button>
    <button class="tab" data-t="holiday" aria-selected="false">Holiday</button>
    <button class="tab" data-t="clothing" aria-selected="false">Clothing</button>
    <button class="tab" data-t="setup" aria-selected="false">Setup</button>
  </div>
  <div id="flash"></div>

  <section data-p="now">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <span class="eyebrow" id="mLabel">&mdash;</span><span class="eyebrow" id="dLeft"></span>
      </div>
      <div class="big" id="big">&mdash;</div>
      <div class="biglabel" id="bigLabel">left to spend on eating out</div>
      <div class="wrap">
        <span class="ticklab" id="tickLab"></span>
        <div class="bar"><div class="fill" id="fill" style="width:0%"></div></div>
        <span class="tick hide" id="tick"></span>
        <div class="ends"><span id="e1">&mdash;</span><span id="e2">&mdash;</span></div>
      </div>
      <dl class="grid">
        <div class="cell"><dt>Budget</dt><dd id="cB">&mdash;</dd></div>
        <div class="cell"><dt>Carried in</dt><dd id="cC">&mdash;</dd></div>
        <div class="cell"><dt>Weekend pot</dt><dd id="cP">&mdash;</dd></div>
      </dl>
    </div>

    <div class="card">
      <h2>Can we afford it?</h2>
      <p class="sub">Checked against this month, then against the weekend pot.</p>
      <div id="goals"></div>
      <div class="row" style="margin-top:14px">
        <input type="text" id="gL" placeholder="Weekend away" style="flex:2">
        <input type="number" id="gA" placeholder="Amount" inputmode="numeric" style="flex:1">
      </div>
      <button class="btn ghost" id="addGoal">Add a splurge</button>
    </div>

    <div class="card">
      <h2>Move the surplus</h2>
      <p class="sub" id="sSub">&mdash;</p>
      <div class="row">
        <input type="number" id="sA" placeholder="Amount" inputmode="numeric">
        <button class="btn" id="doStash" style="flex:0 0 auto;width:auto">To pot</button>
      </div>
      <button class="btn ghost" id="unStash">Return this month's pot money</button>
      <p class="note">Whatever you leave rolls into next month. Pot money stops rolling and just accumulates.</p>
    </div>
  </section>

  <section data-p="log" class="hide">
    <div class="card">
      <h2>Log a meal</h2>
      <p class="sub">For cash, a split bill, or anything the card didn't catch.</p>
      <div class="row">
        <div style="flex:1.4"><label class="fl" for="tN">Where</label><input type="text" id="tN" placeholder="Kloof Street House"></div>
        <div style="flex:1"><label class="fl" for="tA">Amount</label><input type="number" id="tA" inputmode="decimal"></div>
      </div>
      <div class="row"><div><label class="fl" for="tD">Date</label><input type="date" id="tD"></div></div>
      <button class="btn" id="addTx">Add</button>
    </div>
    <div class="card"><h2 id="lH">Meals</h2><p class="sub" id="lS">&mdash;</p><div id="list"></div></div>
  </section>

  <section data-p="months" class="hide">
    <div class="card">
      <h2>What each month handed forward</h2>
      <p class="sub">In is last month's leftover. Pot is money parked for a weekend away.</p>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Month</th><th>Budget</th><th>In</th><th>Spent</th><th>Pot</th><th>Out</th></tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
    </div>
  </section>

  <section data-p="holiday" class="hide" data-pot="holiday">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <span class="eyebrow">Holiday pot</span><span class="eyebrow" data-f="since"></span>
      </div>
      <div class="big" data-f="big">&mdash;</div>
      <div class="biglabel" data-f="bigLabel">saved up and ready to spend</div>
      <div class="wrap" style="margin:22px 0 8px">
        <div class="bar"><div class="fill" data-f="fill" style="width:0%"></div></div>
        <div class="ends"><span data-f="e1">&mdash;</span><span data-f="e2">&mdash;</span></div>
      </div>
      <dl class="grid">
        <div class="cell"><dt>Per month</dt><dd data-f="cM">&mdash;</dd></div>
        <div class="cell"><dt>Built up</dt><dd data-f="cA">&mdash;</dd></div>
        <div class="cell"><dt>Spent</dt><dd data-f="cS">&mdash;</dd></div>
      </dl>
    </div>
    <div class="card">
      <h2>Log a trip</h2>
      <p class="sub">Flights, a deposit, car hire &mdash; whatever comes out of the pot.</p>
      <div class="row">
        <div style="flex:1.4"><label class="fl">What</label><input type="text" data-f="eN" placeholder="Flights to Durban"></div>
        <div style="flex:1"><label class="fl">Amount</label><input type="number" data-f="eA" inputmode="decimal"></div>
      </div>
      <div class="row"><div><label class="fl">Date</label><input type="date" data-f="eD"></div></div>
      <button class="btn" data-f="addEntry">Add</button>
    </div>
    <div class="card"><h2>History</h2><p class="sub" data-f="lS">&mdash;</p><div data-f="list"></div></div>
    <div class="card">
      <h2>Setup</h2>
      <p class="sub">A new monthly amount applies from this month on. What you already built up stays as it is.</p>
      <div class="row">
        <div><label class="fl">Monthly amount</label><input type="number" data-f="setM" inputmode="numeric"></div>
        <div><label class="fl">Building since</label><input type="month" data-f="setStart"></div>
      </div>
      <button class="btn" data-f="saveP">Save</button>
      <p class="note" data-f="rateNote"></p>
    </div>
  </section>

  <section data-p="clothing" class="hide" data-pot="clothing">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <span class="eyebrow">Clothing pot</span><span class="eyebrow" data-f="since"></span>
      </div>
      <div class="big" data-f="big">&mdash;</div>
      <div class="biglabel" data-f="bigLabel">saved up and ready to spend</div>
      <div class="wrap" style="margin:22px 0 8px">
        <div class="bar"><div class="fill" data-f="fill" style="width:0%"></div></div>
        <div class="ends"><span data-f="e1">&mdash;</span><span data-f="e2">&mdash;</span></div>
      </div>
      <dl class="grid">
        <div class="cell"><dt>Per month</dt><dd data-f="cM">&mdash;</dd></div>
        <div class="cell"><dt>Built up</dt><dd data-f="cA">&mdash;</dd></div>
        <div class="cell"><dt>Spent</dt><dd data-f="cS">&mdash;</dd></div>
      </dl>
    </div>
    <div class="card">
      <h2>Log a purchase</h2>
      <p class="sub">Shoes, a jacket, anything that draws the pot down.</p>
      <div class="row">
        <div style="flex:1.4"><label class="fl">What</label><input type="text" data-f="eN" placeholder="Winter boots"></div>
        <div style="flex:1"><label class="fl">Amount</label><input type="number" data-f="eA" inputmode="decimal"></div>
      </div>
      <div class="row"><div><label class="fl">Date</label><input type="date" data-f="eD"></div></div>
      <button class="btn" data-f="addEntry">Add</button>
    </div>
    <div class="card"><h2>History</h2><p class="sub" data-f="lS">&mdash;</p><div data-f="list"></div></div>
    <div class="card">
      <h2>Setup</h2>
      <p class="sub">A new monthly amount applies from this month on. What you already built up stays as it is.</p>
      <div class="row">
        <div><label class="fl">Monthly amount</label><input type="number" data-f="setM" inputmode="numeric"></div>
        <div><label class="fl">Building since</label><input type="month" data-f="setStart"></div>
      </div>
      <button class="btn" data-f="saveP">Save</button>
      <p class="note" data-f="rateNote"></p>
    </div>
  </section>

  <section data-p="setup" class="hide">
    <div class="card">
      <h2>Budget</h2>
      <p class="sub">Applies from this month on. Past months keep their figure.</p>
      <div class="row"><div><label class="fl" for="setB">Monthly eating-out budget</label><input type="number" id="setB" inputmode="numeric"></div></div>
      <div class="row"><div><label class="fl" for="setD">If we overspend</label>
        <select id="setD"><option value="1">Carry the shortfall forward</option><option value="0">Start next month clean</option></select>
      </div></div>
      <button class="btn" id="saveS">Save</button>
    </div>
    <div class="card">
      <h2>Merchant rules</h2>
      <p class="sub">Card spend is filed by merchant code. A rule overrides that whenever the merchant name contains your text.</p>
      <div id="rules"></div>
      <div class="row" style="margin-top:14px">
        <input type="text" id="rM" placeholder="woolworths" style="flex:2" aria-label="Merchant name contains">
        <select id="rC" style="flex:1.3" aria-label="Category">
          <option value="dining">Eating out</option><option value="holiday">Holiday</option><option value="clothing">Clothing</option>
        </select>
      </div>
      <button class="btn ghost" id="addRule">Add rule</button>
      <p class="note">Spend that matches neither a rule nor a merchant code is not tracked. Log it by hand if you want it counted.</p>
    </div>
    <div class="card">
      <h2>Signed in</h2>
      <p class="sub">You are <span id="whoIs" class="tag"></span> on this phone.</p>
      <button class="btn ghost" id="signOut">Sign out of Google here</button>
      <p class="note">Access ends the session for this device. Meals you logged keep your name on them.</p>
    </div>
  </section>
</div>

<script nonce="__NONCE__">
var WHO='', D=null;
var $=function(id){return document.getElementById(id);};
var esc=function(s){return String(s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
var fmt=function(n){return new Intl.NumberFormat('en-ZA',
  {style:'currency',currency:'ZAR',maximumFractionDigits:0}).format(n||0);};
var fmt2=function(n){return new Intl.NumberFormat('en-ZA',
  {style:'currency',currency:'ZAR',minimumFractionDigits:2}).format(n||0);};

function flash(msg,warn){
  $('flash').innerHTML='<div class="flash'+(warn?' warn':'')+'">'+esc(msg)+'</div>';
  setTimeout(function(){$('flash').innerHTML='';},4000);
}
function signOut(){ location.href='/cdn-cgi/access/logout'; }
function showGate(msg, offerSignIn){
  $('app').classList.add('hide');
  $('gate').classList.remove('hide');
  $('gateMsg').textContent=msg;
  $('signIn').classList.toggle('hide',!offerSignIn);
  $('gateHelp').classList.toggle('hide',!offerSignIn);
}

function api(path,body){
  return fetch(path,{
    method:body?'POST':'GET',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined
  }).then(function(r){
    return r.json().catch(function(){return {};}).then(function(j){
      if(r.status===401){ var e=new Error(j.error||'Not signed in.'); e.signin=true; throw e; }
      if(r.status===503){ var e2=new Error(j.error||'Not configured.'); e2.setup=true; throw e2; }
      if(!r.ok) throw new Error(j.error||'Something went wrong.');
      return j;
    });
  });
}
function refresh(body,path){
  return api(path||'/api/state',body).then(function(d){D=d;render();return d;})
    .catch(function(e){
      if(e.signin) showGate('Your session ended. Sign in again to carry on.',true);
      else if(e.setup) showGate(e.message,false);
      else flash(e.message,true);
      throw e;
    });
}
function monthName(k){var p=k.split('-');
  return new Date(+p[0],+p[1]-1,1).toLocaleDateString('en-ZA',{month:'long',year:'numeric'});}
function shortMonth(k){var p=k.split('-');
  return new Date(+p[0],+p[1]-1,1).toLocaleDateString('en-ZA',{month:'short',year:'2-digit'});}
function dayLabel(iso){
  return new Date(iso+'T00:00').toLocaleDateString('en-ZA',{day:'numeric',month:'short'});}

function render(){
  if(!D)return;
  WHO=D.me||'';
  var c=D.current,pot=D.pot;
  $('mLabel').textContent=monthName(c.key);
  var now=new Date(), last=new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  $('dLeft').textContent=(last-now.getDate())+' days left';

  var over=c.remaining<0;
  $('big').textContent=fmt(Math.abs(c.remaining));
  $('big').className='big'+(over?' over':'');
  $('bigLabel').textContent=over?'over budget this month':'left to spend on eating out';

  var denom=Math.max(c.available,c.spent,1);
  $('fill').style.width=Math.min(100,c.spent/denom*100)+'%';
  $('fill').className='fill'+(over?' over':'');
  $('e1').textContent=fmt(c.spent)+' spent';
  $('e2').textContent=fmt(c.available)+' available';

  if(c.carriedIn>0.5&&c.budget<denom){
    var p=c.budget/denom*100;
    $('tick').style.left=p+'%'; $('tick').classList.remove('hide');
    $('tickLab').style.left=p+'%'; $('tickLab').textContent='budget alone ends here';
  }else{ $('tick').classList.add('hide'); $('tickLab').textContent=''; }

  $('cB').textContent=fmt(c.budget);
  $('cC').textContent=fmt(c.carriedIn);
  $('cC').className=c.carriedIn<0?'neg':(c.carriedIn>0?'pos':'');
  $('cP').textContent=fmt(pot);
  $('cP').className=pot>0?'pos':'';

  $('goals').innerHTML=D.goals.length?D.goals.map(function(g){
    var fm=c.remaining>=g.amount, fp=(c.remaining+pot)>=g.amount, ok=fm||fp;
    var sub=fm?'Fits in what is left this month':fp?'Fits if you use the weekend pot'
      :'Short by '+fmt(Math.max(g.amount-Math.max(c.remaining,0)-pot,0));
    return '<div class="item"><span class="dot '+(ok?'yes':'no')+'">'+(ok?'&#10003;':'&#10007;')+'</span>'+
      '<span class="n">'+esc(g.label)+'<div class="gs">'+sub+'</div></span>'+
      '<span class="a" style="color:var(--muted)">'+fmt(g.amount)+'</span>'+
      '<button class="x" data-goal="'+esc(g.id)+'" aria-label="Remove">&times;</button></div>';
  }).join(''):'<div class="empty">Add the meal or trip you are eyeing.</div>';

  $('sSub').textContent=over
    ?'You are '+fmt(Math.abs(c.remaining))+' over. Nothing to move yet.'
    :fmt(c.remaining)+' spare. Move some to the pot so it does not get eaten.';

  $('lH').textContent=monthName(c.key);
  $('lS').textContent=(c.txns.length?c.txns.length+' meals, '+fmt(c.spent)+' total':'Nothing logged yet.')+pendNote(c.txns);
  $('list').innerHTML=c.txns.length?c.txns.map(function(t){return entryRow('dining',t);}).join('')
    :'<div class="empty">Nothing yet this month.</div>';

  $('rows').innerHTML=D.months.map(function(r){
    return '<tr><td>'+shortMonth(r.key)+'</td><td>'+fmt(r.budget)+'</td>'+
      '<td class="'+(r.carriedIn<0?'neg':(r.carriedIn>0?'pos':''))+'">'+fmt(r.carriedIn)+'</td>'+
      '<td>'+fmt(r.spent)+'</td><td class="'+(r.stashed>0?'pos':'')+'">'+
      (r.stashed?fmt(r.stashed):'&mdash;')+'</td>'+
      '<td class="'+(r.remaining<0?'neg':'pos')+'">'+fmt(r.remaining)+'</td></tr>';
  }).join('');

  $('setB').value=D.settings.monthlyBudget;
  $('setD').value=D.settings.carryDeficit?'1':'0';
  $('whoIs').textContent=WHO||'signed in';

  $('rules').innerHTML=(D.rules&&D.rules.length)?D.rules.map(function(r){
    return '<div class=\"item\"><span class=\"n\">'+esc(r.match)+'</span>'+
      '<span class=\"a\" style=\"color:var(--muted)\">'+esc(catLabel(r.category))+'</span>'+
      '<button class=\"x\" data-rule=\"'+esc(r.match)+'\" aria-label=\"Remove\">&times;</button></div>';
  }).join(''):'<div class=\"empty\">No rules yet. Merchant codes decide.</div>';

  renderPot('holiday'); renderPot('clothing');
}

function catLabel(k){
  var c=(D.cats||[]).filter(function(x){return x.key===k;})[0];
  return c?c.label:k;
}
function catOptions(cur){
  return '<option value=\"\">&#8644;</option>'+(D.cats||[]).filter(function(c){return c.key!==cur;}).map(function(c){
    return '<option value=\"'+esc(c.key)+'\">To '+esc(c.label)+'</option>';
  }).join('');
}
function pendNote(list){
  var n=list.filter(function(t){return t.pending;}).length;
  return n?' \u00b7 '+n+' awaiting a rand amount':'';
}
// One row for every ledger. Card entries held at R0 show what the card
// reported and a button to say what it really cost in rand.
function entryRow(ledger,e){
  var amt=(e.pending&&e.foreign)
    ?'<button class=\"btn ghost sm\" data-settle=\"'+esc(ledger)+'\" data-id=\"'+esc(e.id)+'\" data-cur=\"'+esc(e.foreign.currency)+
      '\" data-amt=\"'+esc(e.foreign.amount)+'\">'+esc(e.foreign.currency)+' '+Number(e.foreign.amount).toFixed(2)+' &middot; set R</button>'
    :'<span class=\"a\">'+fmt2(e.amount)+'</span>';
  var del=ledger==='dining'
    ?'<button class=\"x\" data-tx=\"'+esc(e.id)+'\" aria-label=\"Remove\">&times;</button>'
    :'<button class=\"x\" data-pot-del=\"'+esc(ledger)+'\" data-id=\"'+esc(e.id)+'\" aria-label=\"Remove\">&times;</button>';
  var mv='<select class=\"mv\" data-mv=\"'+esc(ledger)+'\" data-id=\"'+esc(e.id)+'\" aria-label=\"Move to another category\">'+catOptions(ledger)+'</select>';
  return '<div class=\"item\"><span class=\"d\">'+dayLabel(e.date)+'</span>'+
    '<span class=\"n\">'+esc(e.name)+(e.by?' <span class=\"tag\">'+esc(e.by)+'</span>':'')+'</span>'+amt+mv+del+'</div>';
}

function potEl(pot,f){return document.querySelector('[data-pot=\"'+pot+'\"] [data-f=\"'+f+'\"]');}

function renderPot(pot){
  var p=D.pots&&D.pots[pot]; if(!p) return;
  var set=function(f,v){var el=potEl(pot,f); if(el) el.textContent=v;};

  var over=p.available<0;
  set('big',fmt(Math.abs(p.available)));
  potEl(pot,'big').className='big'+(over?' over':'');
  set('bigLabel',over?'drawn past what has built up':'saved up and ready to spend');
  set('since',p.started?(p.months+(p.months===1?' month':' months')+' building'):'not started');

  var denom=Math.max(p.accrued,p.spent,1);
  var fill=potEl(pot,'fill');
  fill.style.width=Math.min(100,p.spent/denom*100)+'%';
  fill.className='fill'+(over?' over':'');
  set('e1',fmt(p.spent)+' spent');
  set('e2',fmt(p.accrued)+' built up');

  set('cM',fmt(p.monthly));
  set('cA',fmt(p.accrued));
  set('cS',fmt(p.spent));
  potEl(pot,'cA').className='pos';
  potEl(pot,'cS').className=p.spent>0?'neg':'';

  set('lS',(p.entries.length
    ? p.entries.length+(p.entries.length===1?' entry, ':' entries, ')+fmt(p.spent)+' total'
    : 'Nothing logged yet.')+pendNote(p.entries));
  potEl(pot,'list').innerHTML=p.entries.length?p.entries.map(function(e){return entryRow(pot,e);}).join('')
    :'<div class="empty">Nothing drawn from this pot yet.</div>';

  var m=potEl(pot,'setM'); if(document.activeElement!==m) m.value=p.monthly;
  var st=potEl(pot,'setStart'); if(document.activeElement!==st) st.value=p.started||'';

  set('rateNote',p.rates.length>1
    ? 'Rate changed '+(p.rates.length-1)+(p.rates.length===2?' time':' times')+': '+
      p.rates.map(function(r){return fmt(r.monthly)+' from '+shortMonth(r.from);}).join(', ')+'.'
    : 'Accrues every month without resetting, including over year end.');
}

document.querySelectorAll('.tab').forEach(function(t){
  t.onclick=function(){
    document.querySelectorAll('.tab').forEach(function(x){x.setAttribute('aria-selected',x===t);});
    document.querySelectorAll('[data-p]').forEach(function(p){p.classList.toggle('hide',p.dataset.p!==t.dataset.t);});
  };
});
document.addEventListener('click',function(e){
  var g=e.target.closest('[data-goal]');
  if(g) return refresh({remove:g.dataset.goal},'/api/goal').catch(function(){});
  var t=e.target.closest('[data-tx]');
  if(t) return refresh({id:t.dataset.tx},'/api/tx/delete').catch(function(){});
  var pd=e.target.closest('[data-pot-del]');
  if(pd) return refresh({pot:pd.dataset.potDel,id:pd.dataset.id},'/api/pot/entry/delete').catch(function(){});
  var rr=e.target.closest('[data-rule]');
  if(rr) return refresh({match:rr.dataset.rule,category:''},'/api/rule').catch(function(){});
  var st=e.target.closest('[data-settle]');
  if(st){
    var v=prompt('How many rand was '+st.dataset.cur+' '+Number(st.dataset.amt).toFixed(2)+'? Check your bank statement.');
    if(v===null) return;
    var r=parseFloat(String(v).replace(',','.'));
    if(!(r>0)) return flash('Enter the rand amount.',true);
    return refresh({ledger:st.dataset.settle,id:st.dataset.id,amount:r},'/api/alloc/settle').catch(function(){});
  }
});

// Re-home an entry. Merchant codes misfile things; this is the correction.
document.addEventListener('change',function(e){
  var sel=e.target.closest?e.target.closest('select[data-mv]'):null;
  if(!sel||!sel.value) return;
  refresh({from:sel.dataset.mv,to:sel.value,id:sel.dataset.id},'/api/alloc/move')
    .then(function(){flash('Moved. Add a merchant rule in Setup to do this automatically next time.');})
    .catch(function(){});
});
$('addRule').onclick=function(){
  var m=$('rM').value.trim();
  if(m.length<3) return flash('Type at least 3 letters of the merchant name.',true);
  refresh({match:m,category:$('rC').value},'/api/rule')
    .then(function(){$('rM').value='';flash('Rule saved.');}).catch(function(){});
};

['holiday','clothing'].forEach(function(pot){
  potEl(pot,'addEntry').onclick=function(){
    var a=parseFloat(potEl(pot,'eA').value);
    if(!(a>0)) return flash('Enter an amount above zero.',true);
    refresh({pot:pot,name:potEl(pot,'eN').value.trim(),amount:a,date:potEl(pot,'eD').value},'/api/pot/entry')
      .then(function(){potEl(pot,'eN').value='';potEl(pot,'eA').value='';flash('Logged.');})
      .catch(function(){});
  };
  potEl(pot,'saveP').onclick=function(){
    var body={pot:pot};
    var m=parseFloat(potEl(pot,'setM').value);
    if(m>0) body.monthly=m;
    var st=potEl(pot,'setStart').value;
    if(st) body.startMonth=st;
    refresh(body,'/api/pot/settings').then(function(){flash('Saved.');}).catch(function(){});
  };
});
$('addTx').onclick=function(){
  var a=parseFloat($('tA').value);
  if(!(a>0)) return flash('Enter an amount above zero.',true);
  refresh({name:$('tN').value.trim(),amount:a,date:$('tD').value},'/api/tx')
    .then(function(){$('tN').value='';$('tA').value='';flash('Logged.');}).catch(function(){});
};
$('addGoal').onclick=function(){
  refresh({label:$('gL').value.trim(),amount:parseFloat($('gA').value)},'/api/goal')
    .then(function(){$('gL').value='';$('gA').value='';}).catch(function(){});
};
$('doStash').onclick=function(){
  var a=parseFloat($('sA').value);
  if(!(a>0)) return flash('Enter an amount to move.',true);
  refresh({amount:a},'/api/stash').then(function(){$('sA').value='';}).catch(function(){});
};
$('unStash').onclick=function(){refresh({amount:-1e9},'/api/stash').catch(function(){});};
$('saveS').onclick=function(){
  refresh({monthlyBudget:parseFloat($('setB').value),carryDeficit:$('setD').value==='1'},'/api/settings')
    .then(function(){flash('Saved.');}).catch(function(){});
};
$('signOut').onclick=signOut;

function open_(){
  return api('/api/state').then(function(d){
    D=d;
    $('gate').classList.add('hide');
    $('app').classList.remove('hide');
    var today=new Date(Date.now()+2*3600e3).toISOString().slice(0,10);
    $('tD').value=today;
    potEl('holiday','eD').value=today;
    potEl('clothing','eD').value=today;
    render();
  });
}
$('signIn').onclick=function(){ location.reload(); };

open_().catch(function(e){
  if(e.setup) showGate(e.message+' Set ACCESS_TEAM and ACCESS_AUD as Worker secrets (docs/03).',false);
  else showGate('You are not signed in.',true);
});

document.addEventListener('visibilitychange',function(){
  if(!document.hidden&&D) refresh().catch(function(){});
});
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(){});
</script>
</body>
</html>`;
