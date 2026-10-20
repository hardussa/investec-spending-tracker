'use strict';
const { makeHarness, reporter } = require('./harness.cjs');
const { check, done } = reporter();

const now = () => Math.floor(Date.now() / 1000);

(async () => {
  /* ------------------------------------------------------------------ */
  console.log('--- the Worker verifies Cloudflare Access tokens itself ---');
  const h = await makeHarness();
  const state = (opts) => h.send('/api/state', opts || {});

  check('no token is refused', (await state()).status === 401);
  check('a valid token is accepted', (await state({ token: h.mint() })).status === 200);

  check('an expired token is refused', (await state({ token: h.mint({ exp: now() - 10 }) })).status === 401);
  check('a token with no expiry is refused', (await state({ token: h.mint({ exp: undefined }) })).status === 401);
  check('a token meant for a different Access app is refused', (await state({ token: h.mint({ aud: ['another-apps-tag'] }) })).status === 401);
  check('our app among several audiences is accepted', (await state({ token: h.mint({ aud: ['another-apps-tag', h.AUD] }) })).status === 200);
  check('a token from a different team is refused', (await state({ token: h.mint({ iss: 'https://test-other-team.cloudflareaccess.com' }) })).status === 401);
  check('a token not yet valid is refused', (await state({ token: h.mint({ nbf: now() + 3600 }) })).status === 401);
  check('a little clock skew on nbf is tolerated', (await state({ token: h.mint({ nbf: now() + 30 }) })).status === 200);
  check('a token signed by an unknown key id is refused', (await state({ token: h.mint({}, { kid: 'not-a-real-key' }) })).status === 401);

  console.log('\n--- forged tokens ---');
  const claims = { aud: [h.AUD], email: h.EMAIL, exp: now() + 3600, iss: 'https://' + h.TEAM + '.cloudflareaccess.com', sub: 'u' };
  check('alg "none" (unsigned) is refused',
    (await state({ token: h.mintRaw({ alg: 'none', kid: 'k', typ: 'JWT' }, claims, 'none') })).status === 401);
  check('HS256 "algorithm confusion" is refused',
    (await state({ token: h.mintRaw({ alg: 'HS256', kid: 'k', typ: 'JWT' }, claims, { hmac: 'any-shared-secret' }) })).status === 401);
  check('a token signed with an attacker\'s own RSA key is refused',
    (await state({ token: h.mintRaw({ alg: 'RS256', kid: 'k', typ: 'JWT' }, claims, h.attackerKey) })).status === 401);

  const valid = h.mint();
  const [vh, , vs] = valid.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(Object.assign({}, claims, { email: 'someone-else@example.com' })))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('a valid signature moved onto edited claims is refused', (await state({ token: vh + '.' + forgedPayload + '.' + vs })).status === 401);

  for (const junk of ['abc', 'a.b', 'a.b.c', '....', 'Bearer x.y.z', '%%%.%%%.%%%']) {
    const r = await state({ token: junk });
    check('garbage token "' + junk + '" gives 401, not a crash', r.status === 401, 'status=' + r.status);
  }

  const viaCookie = await state({ headers: { Cookie: 'theme=dark; CF_Authorization=' + h.mint() } });
  check('the CF_Authorization cookie is accepted (how a browser arrives)', viaCookie.status === 200);

  console.log('\n--- who counts as a person ---');
  const strict = await makeHarness(null, { ALLOWED_EMAILS: 'tester@example.com, Second.Person@Example.com' });
  check('an allow-listed email is accepted', (await strict.send('/api/state', { token: strict.mint() })).status === 200);
  check('the allow-list ignores case and spaces', (await strict.send('/api/state', { token: strict.mint({ email: 'SECOND.person@example.COM' }) })).status === 200);
  check('a valid token for an email NOT on the allow-list is refused', (await strict.send('/api/state', { token: strict.mint({ email: 'stranger@example.com' }) })).status === 401);

  const open = await makeHarness(null, { ALLOWED_EMAILS: '' });
  check('an empty ALLOWED_EMAILS defers to the Access policy (documented behaviour)',
    (await open.send('/api/state', { token: open.mint({ email: 'anyone@example.com' }) })).status === 200);

  console.log('\n--- a service token must never pass as a person ---');
  // Cloudflare issues a valid, correctly signed JWT for a service token: same
  // audience, but no email and an empty sub. With ALLOWED_EMAILS empty this used
  // to be accepted as a signed-in user.
  const svc = open.mintServiceToken();
  const svcRead = await open.send('/api/state', { token: svc });
  check('service-token JWT cannot read state, even with ALLOWED_EMAILS empty', svcRead.status === 401, 'status=' + svcRead.status);
  const svcWrite = await open.send('/api/tx', { body: { name: 'Injected', amount: 999 }, token: svc });
  check('service-token JWT cannot write either', svcWrite.status === 401, 'status=' + svcWrite.status);
  check('and nothing was stored by the attempt', !open.kv.has('dining-state'));
  check('service-token JWT is refused when an allow-list is set too',
    (await strict.send('/api/state', { token: strict.mintServiceToken() })).status === 401);
  check('a token with an empty-string email is refused', (await open.send('/api/state', { token: open.mint({ email: '' }) })).status === 401);

  console.log('\n--- misconfiguration fails closed ---');
  const noTeam = await makeHarness(null, { ACCESS_TEAM: undefined });
  let r = await noTeam.send('/api/state', { token: noTeam.mint() });
  check('no ACCESS_TEAM -> 503 and a setup hint, never open access', r.status === 503 && r.json && r.json.setup === true, 'status=' + r.status);
  const noAud = await makeHarness(null, { ACCESS_AUD: undefined });
  r = await noAud.send('/api/state', { token: noAud.mint() });
  check('no ACCESS_AUD -> 503', r.status === 503, 'status=' + r.status);
  r = await noAud.send('/api/state', {});
  check('and still 503 (not 200) with no token at all', r.status === 503);

  const down = await makeHarness();
  down.failJwks = true;
  r = await down.send('/api/state', { token: down.mint() });
  check('if Cloudflare\'s signing keys cannot be fetched, requests are refused (401), not allowed', r.status === 401, 'status=' + r.status);
  down.failJwks = false;
  r = await down.send('/api/state', { token: down.mint() });
  check('and it recovers on its own once the keys are reachable', r.status === 200, 'status=' + r.status);

  const cache = await makeHarness();
  await cache.send('/api/state', { token: cache.mint() });
  await cache.send('/api/state', { token: cache.mint() });
  await cache.send('/api/state', { token: cache.mint() });
  check('signing keys are cached, not re-fetched on every request', cache.jwksFetches === 1, 'fetches=' + cache.jwksFetches);

  console.log('\n--- the card endpoint ---');
  const body = { v: 2, mcc: '5812', name: 'Test Cafe', amount: 10, currency: 'zar' };
  check('no card key is refused', (await h.send('/api/card', { body })).status === 401);
  check('a wrong card key is refused', (await h.card(body, 'wrong')).status === 401);
  check('a card key of a different length is refused', (await h.card(body, h.CARD_KEY + 'x')).status === 401);
  check('an empty card key is refused', (await h.card(body, '')).status === 401);
  check('a human\'s Access token alone does not authorise the card endpoint', (await h.send('/api/card', { body, token: h.TOKEN })).status === 401);
  check('the correct card key is accepted', (await h.card(body)).status === 200);
  check('the card key does not unlock the app\'s routes', (await h.send('/api/state', { headers: { 'x-card-key': h.CARD_KEY } })).status === 401);
  check('GET on the card endpoint is not a way in', (await h.send('/api/card', { method: 'GET', headers: { 'x-card-key': h.CARD_KEY } })).status === 401);

  const noKey = await makeHarness(null, { CARD_KEY: undefined });
  check('with CARD_KEY unset, an empty key does not match', (await noKey.card(body, '')).status === 401);
  check('with CARD_KEY unset, the string "undefined" does not match', (await noKey.card(body, 'undefined')).status === 401);

  console.log('\n--- no secret is ever stored or echoed ---');
  const stored = JSON.stringify(h.stored());
  for (const [label, secret] of [['card key', h.CARD_KEY], ['access token', h.TOKEN], ['audience tag', h.AUD], ['team name', h.TEAM]]) {
    check('the ' + label + ' is not in the stored state', !stored.includes(secret));
  }
  const bad = await h.card(body, 'wrong');
  check('the 401 body does not echo the submitted key', !bad.text.includes('wrong') && !bad.text.includes(h.CARD_KEY), bad.text);

  console.log('\n--- input limits ---');
  r = await h.send('/api/tx', { rawBody: JSON.stringify({ name: 'x'.repeat(9000), amount: 5 }), token: h.TOKEN });
  check('an oversized body is rejected', r.status === 400, 'status=' + r.status);
  r = await h.send('/api/tx', { rawBody: '{not json', token: h.TOKEN });
  check('malformed JSON is a 400', r.status === 400, 'status=' + r.status);
  for (const bodyText of ['null', '[]', '"str"', '42']) {
    r = await h.send('/api/tx', { rawBody: bodyText, token: h.TOKEN });
    check('a JSON body of ' + bodyText + ' is a clean 400, not a 500', r.status === 400, 'status=' + r.status);
  }
  for (const amount of [0, -5, 1e9, 'abc', null, 'Infinity']) {
    r = await h.card({ v: 2, mcc: '5812', name: 'Amt', amount, currency: 'zar' });
    check('card amount ' + JSON.stringify(amount) + ' is refused', r.status === 400, 'status=' + r.status);
  }
  r = await h.card({ v: 2, mcc: '5812', name: 'N'.repeat(500), amount: 12.34, currency: 'zar' });
  const names = Object.values(h.stored().months).flatMap(m => m.txns.map(t => t.name));
  check('an over-long merchant name is trimmed, not stored whole', r.status === 200 && names.every(n => n.length <= 60), 'max=' + Math.max(...names.map(n => n.length)));
  r = await h.card({ v: 2, mcc: '5812', name: 'Line\nBreak\u0000Name', amount: 12.35, currency: 'zar' });
  const allNames = Object.values(h.stored().months).flatMap(m => m.txns.map(t => t.name));
  check('control characters are stripped from names', !allNames.some(n => /[\u0000-\u001f]/.test(n)));
  r = await h.card({ v: 2, mcc: '5812', name: 'Future Cafe', amount: 7.77, currency: 'zar', date: '2999-01-01' });
  const fc = Object.values(h.stored().months).flatMap(m => m.txns).find(t => t.name === 'Future Cafe');
  check('an absurd date is ignored in favour of today', r.status === 200 && fc && !fc.date.startsWith('2999'), fc && fc.date);

  r = await h.send('/api/tx', { method: 'GET', token: h.TOKEN });
  check('GET on a POST-only route is a 404', r.status === 404, 'status=' + r.status);
  r = await h.send('/api/does-not-exist', { body: {}, token: h.TOKEN });
  check('an unknown route is a 404 when signed in', r.status === 404, 'status=' + r.status);
  r = await h.send('/api/does-not-exist', { body: {} });
  check('and a 401 when not, so routes are not enumerable', r.status === 401, 'status=' + r.status);

  console.log('\n--- the page and its headers ---');
  await h.card({ v: 2, mcc: '5812', name: 'SECRETMERCHANTNAME', amount: 55, currency: 'zar' });
  const page1 = await h.send('/');
  const page2 = await h.send('/');
  const csp = page1.headers.get('content-security-policy') || '';
  check('the page is served', page1.status === 200 && /<title>/i.test(page1.text));
  check('CSP denies everything by default', /default-src 'none'/.test(csp));
  check('CSP allows scripts only by nonce', /script-src 'nonce-[a-f0-9]+'/.test(csp));
  check('CSP has no unsafe-inline or unsafe-eval', !/unsafe-inline|unsafe-eval/.test(csp), csp);
  check('CSP forbids framing and limits connections to itself', /frame-ancestors 'none'/.test(csp) && /connect-src 'self'/.test(csp));
  const nonce = (csp.match(/'nonce-([a-f0-9]+)'/) || [])[1];
  check('the nonce in the header matches the one in the page', !!nonce && page1.text.includes('nonce="' + nonce + '"'));
  const nonce2 = ((page2.headers.get('content-security-policy') || '').match(/'nonce-([a-f0-9]+)'/) || [])[1];
  check('a fresh nonce is generated for every request', !!nonce2 && nonce2 !== nonce);
  check('the page is not cacheable', /no-store/.test(page1.headers.get('cache-control') || ''));
  check('X-Frame-Options, nosniff, HSTS and Referrer-Policy are set',
    page1.headers.get('x-frame-options') === 'DENY' && page1.headers.get('x-content-type-options') === 'nosniff' &&
    /max-age=\d+/.test(page1.headers.get('strict-transport-security') || '') && page1.headers.get('referrer-policy') === 'no-referrer');
  check('API responses carry the security headers too',
    (await state({ token: h.TOKEN })).headers.get('x-content-type-options') === 'nosniff');
  check('the HTML itself contains no user data', !page1.text.includes('SECRETMERCHANTNAME'));

  const external = (page1.text.match(/https?:\/\/[^\s"'<>)\\]+/g) || []).filter(u => !u.startsWith('http://www.w3.org/'));
  check('the page loads nothing from any third party', external.length === 0, external.join(', '));
  check('robots.txt disallows crawling', /Disallow: \//.test((await h.send('/robots.txt')).text));
  check('the page is marked noindex', /noindex/.test(page1.text) && /noindex/.test(page1.headers.get('x-robots-tag') || ''));

  done('security tests passed');
})();
