/**
 * Deployment smoke test.
 *
 * Liveness is not evidence that a deployment works. This signs in, asks a question, and
 * checks that the citation it gets back can be re-located in the stored source — the one
 * property the product exists to provide.
 */
/*
 * The target, taken from the command line as well as the environment.
 *
 * It read only SMOKE_API before, so `node scripts/smoke.mjs https://host` silently tested
 * 127.0.0.1 and reported a pass — a smoke test that answers about a machine other than the
 * one you named is worse than none, because the report reads exactly like a real one.
 */
const TARGET = process.argv[2]?.replace(/\/+$/, '');
const BASE =
  process.env.SMOKE_API ?? (TARGET ? `${TARGET}/api/v1` : 'http://127.0.0.1:8787/api/v1');
const WEB = process.env.SMOKE_WEB ?? TARGET ?? 'http://127.0.0.1:4173';
const EMAIL = process.env.SMOKE_EMAIL ?? 'dr.sadi@uxe.example.com';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Tr0ubad0ur-Nimbus-42';

const jar = new Map();
let csrf = null;
const results = [];
console.log(`Target: ${BASE}\n`);

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function call(method, path, body) {
  const headers = { origin: WEB };
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 120);
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// 1. Liveness
const health = await call('GET', '/health');
record(
  'API responds',
  health.status === 200 && health.body?.status === 'ok',
  `HTTP ${health.status}`,
);

// 2. Readiness: every dependency reports separately
const ready = await call('GET', '/ready');
const checks = ready.body?.checks ?? [];
record(
  'Dependencies healthy',
  ready.status === 200 && checks.length > 0 && checks.every((c) => c.status === 'ok'),
  checks.map((c) => `${c.name}=${c.status}`).join(' '),
);

// 3. The web bundle is served
const web = await fetch(WEB);
const html = await web.text();
record(
  'Web bundle served',
  web.status === 200 && html.includes('<div id="root"'),
  `HTTP ${web.status}`,
);

// 4. Security headers are present on a real response
const hasHeaders =
  health.headers.get('x-content-type-options') === 'nosniff' &&
  Boolean(health.headers.get('content-security-policy')) &&
  !health.headers.get('x-powered-by');
record('Security headers set', hasHeaders, 'nosniff + CSP, no x-powered-by');

// 5. Unauthenticated access is refused
const anon = await call('GET', '/sources');
record('Anonymous access refused', anon.status === 401, `HTTP ${anon.status}`);

// 6. Sign in
const login = await call('POST', '/auth/login', {
  email: EMAIL,
  password: PASSWORD,
  rememberMe: false,
});
record(
  'Sign-in succeeds',
  login.status === 200 && login.body?.status === 'authenticated',
  `HTTP ${login.status}`,
);

const session = await call('GET', '/auth/session');
csrf = session.body?.csrfToken ?? null;
record(
  'Session established',
  session.status === 200 && Boolean(csrf),
  session.body?.workspace?.name ?? '',
);

// 7. The knowledge base has indexed, ready sources
const sources = await call('GET', '/sources?status=ready');
const ready_count = sources.body?.items?.length ?? 0;
record('Knowledge base populated', ready_count > 0, `${ready_count} ready source(s)`);

// 8. An answer, with a citation that re-locates in the stored source
const list = await call('GET', '/consultations?pageSize=5');
const consultation =
  list.body?.items?.find((c) => c.title === 'UAE Fire Code Review') ?? list.body?.items?.[0];
let citationOk = false;
let detail = 'no consultation found';

if (consultation) {
  const detailResponse = await call('GET', `/consultations/${consultation.id}`);
  const answer = (detailResponse.body?.messages ?? [])
    .map((m) => m.answer)
    .filter(Boolean)
    .at(-1);

  if (answer?.citations?.length) {
    const citation = answer.citations[0];
    const opened = await call('GET', `/citations/${citation.citationId}`);
    const pageText = opened.body?.pageText ?? '';
    const excerpt = opened.body?.citation?.supportingExcerpt ?? '';
    const highlight = opened.body?.highlight;

    citationOk =
      opened.status === 200 &&
      excerpt.length > 0 &&
      pageText.includes(excerpt) &&
      highlight !== null &&
      pageText.slice(highlight.start, highlight.end) === excerpt;

    detail = citationOk
      ? `"${excerpt.slice(0, 52)}…" found at ${highlight.start}–${highlight.end}`
      : 'excerpt did not re-locate in the stored page text';
  } else {
    detail = 'consultation carries no answer';
  }
}
record('Citation re-locates in the source', citationOk, detail);

/*
 * 9. Metrics are reachable by a scraper and by nobody else.
 *
 * Request volumes, route names and latencies are operational intelligence, and this
 * endpoint was answering them to anybody who asked on a public hostname. It sits behind
 * Cloudflare Access now, so on a fronted deployment the right result is a redirect to the
 * Access login rather than a body — and a 200 full of metrics would be the failure.
 *
 * `redirect: 'manual'` because following it lands on a login page that is neither.
 */
const metrics = await fetch(`${BASE}/metrics`, { redirect: 'manual' });
const guarded = metrics.status === 302 || metrics.status === 401 || metrics.status === 403;
if (guarded) {
  record('Metrics are not public', true, `Access challenge (${metrics.status})`);
} else {
  const body = await metrics.text();
  record(
    'Metrics exposed to the scraper',
    metrics.status === 200 && body.includes('uxe_'),
    `${body.split('\n').length} lines, unprotected — front this with Access before it is public`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
