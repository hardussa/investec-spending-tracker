'use strict';
/*
 * Test harness. Runs the real Worker through its real router, with:
 *   - an in-memory stand-in for the KV namespace,
 *   - real RS256 signing keys and a mock of Cloudflare's JWKS endpoint, so the
 *     Worker's actual token verification runs (nothing about auth is stubbed),
 *   - helpers to mint valid, expired, forged and service-token-shaped JWTs.
 *
 * Every email, team name, tag and key below is a made-up test value.
 */
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

const TEAM = 'test-team';
const AUD = 'test-aud-tag';
const EMAIL = 'tester@example.com';
const CARD_KEY = 'test-card-key-not-a-real-secret';

const WORKER_PATH = path.resolve(__dirname, '..', 'src', 'worker.js');

// One signing key pair for the whole run. Harnesses share one global fetch mock, so
// per-harness keys would make results depend on the order harnesses were created.
const GOOD = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ATTACKER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = () => Math.floor(Date.now() / 1000);

async function makeHarness(initialState, envOverrides) {
  const kv = new Map();
  if (initialState) kv.set('dining-state', JSON.stringify(initialState));
  const STATE = {
    get: async k => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); }
  };

  const good = GOOD;
  const attacker = ATTACKER;
  const jwk = good.publicKey.export({ format: 'jwk' });
  jwk.kid = 'k'; jwk.alg = 'RS256'; jwk.use = 'sig';

  const harness = { jwksFetches: 0, failJwks: false };

  // The Worker fetches Cloudflare's signing keys; answer that and nothing else.
  globalThis.fetch = async url => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      harness.jwksFetches++;
      if (harness.failJwks) throw new Error('network down');
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }
    throw new Error('unexpected outbound fetch: ' + url);
  };

  const env = Object.assign({
    STATE, ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL, CARD_KEY
  }, envOverrides || {});

  // A fresh module instance per harness, so the Worker's JWKS cache starts empty.
  const worker = (await import(pathToFileURL(WORKER_PATH).href + '?' + Math.random())).default;

  // ---- tokens ----
  const humanClaims = () => ({
    aud: [AUD], email: EMAIL, exp: now() + 3600, iat: now(), nbf: now(),
    iss: 'https://' + TEAM + '.cloudflareaccess.com', type: 'app', sub: 'user-1'
  });

  // Sign arbitrary header + claims with arbitrary key material.
  function mintRaw(header, claims, signWith) {
    const signing = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
    let sig;
    if (signWith === 'none') sig = '';
    else if (signWith && signWith.hmac) sig = b64url(crypto.createHmac('sha256', signWith.hmac).update(signing).digest());
    else sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(signing), signWith || good.privateKey));
    return signing + '.' + sig;
  }

  // A correctly signed token from "Cloudflare", with claims you can override.
  const mint = (overrides, headerOverrides) =>
    mintRaw(Object.assign({ alg: 'RS256', kid: 'k', typ: 'JWT' }, headerOverrides || {}),
            Object.assign(humanClaims(), overrides || {}), good.privateKey);

  // What Cloudflare issues when a SERVICE TOKEN authenticates: no email, empty sub.
  const mintServiceToken = (overrides) => mint(Object.assign(
    { email: undefined, sub: '', common_name: 'abc123.access' }, overrides || {}));

  const TOKEN = mint();

  // ---- requests ----
  async function send(pathname, { method, body, headers, token, rawBody } = {}) {
    const h = Object.assign({}, headers || {});
    if (token) h['Cf-Access-Jwt-Assertion'] = token;
    const hasBody = body !== undefined || rawBody !== undefined;
    if (hasBody) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request('https://spend.test' + pathname, {
      method: method || (hasBody ? 'POST' : 'GET'),
      headers: h,
      body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined)
    }), env);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }

  // Signed-in call from the phone app.
  const app = (pathname, body) => send(pathname, { body, token: TOKEN });

  // Call from the card (the Cloudflare Access service token is Access's job; the
  // Worker itself only checks the shared secret).
  const card = (body, key) => send('/api/card', {
    body, headers: { 'x-card-key': key === undefined ? CARD_KEY : key }
  });

  const stored = () => JSON.parse(kv.get('dining-state'));

  return Object.assign(harness, {
    worker, env, kv, app, card, send, stored, mint, mintRaw, mintServiceToken,
    TOKEN, CARD_KEY, TEAM, AUD, EMAIL, attackerKey: attacker.privateKey, WORKER_PATH
  });
}

function reporter() {
  let fails = 0;
  return {
    check(label, cond, extra) {
      if (!cond) fails++;
      console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra !== undefined ? '  ' + extra : ''));
    },
    done(msg) {
      console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\n' + (msg || 'all passed'));
      process.exit(fails ? 1 : 0);
    }
  };
}

module.exports = { makeHarness, reporter, WORKER_PATH, TEAM, AUD, EMAIL, CARD_KEY };
