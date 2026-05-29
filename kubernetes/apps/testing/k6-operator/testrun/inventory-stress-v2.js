import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ============================================================================
// INVENTORY STRESS — v2 (dev2)  [k6-operator / Kubernetes edition]
//
// Focused load test of POST /api/inventories (the GetInventories endpoint) in
// isolation, to see how the API + managed Redis L2 (FusionCache) hold up.
//
// The endpoint is a 120s read-through cache keyed per-SKU. With a ~1000-SKU
// working set and small per-request batches, the cache WARMS within the 2-min
// TTL at any meaningful rps — so this primarily exercises the warm Redis read
// path (the realistic steady state). Early in the run it is miss-heavy (cold),
// then shifts to hits — watch the Grafana Redis panels for that transition.
//
// Distributed run via k6-operator: the operator splits the arrival rate across
// `spec.parallelism` runner pods using execution segments. PEAK / DURATION are
// passed as env vars by the TestRun (testrun.yaml).
//
// Differences from the local CLI version of this script:
//   * open() reads ./inventory-skus.json (script + data are mounted flat into
//     /test/ from the same ConfigMap), not ./k6-tests/data/...
//   * handleSummary writes to stdout only. In distributed mode each runner pod
//     produces its OWN partial summary, so the file write was dropped — read
//     per-runner summaries in pod logs, and use Grafana for the aggregate view.
// ============================================================================

const CONFIG = {
  // Injected from the SOPS secret (k6-secrets) via runner env so the dilling
  // endpoint + store key aren't published in this public repo — a fork can't
  // decrypt them, so its runners have no valid target. NOT a security boundary
  // (values remain in git history; lock down dev2 access for that).
  baseUrl: __ENV.K6_BASE_URL || '',
  storeKey: __ENV.K6_STORE_KEY || '',
  testId: __ENV.TEST_ID || 'k6-operator',
};

// Full SKU catalog slice, loaded once and shared across all VUs.
const SKUS = new SharedArray('skus', function () {
  return JSON.parse(open('./inventory-skus.json'));
});

// Per-request batch size. Larger batches (20-30) stress the per-SKU cache path
// harder: each request does N parallel L2 TryGet lookups + (on miss) a batched
// CT fetch + N L2 SetCache writes + backplane invalidations. This is heavier on
// Redis/FusionCache than the realistic cart-sized 1-8.
const MIN_BATCH = 20;
const MAX_BATCH = 30;

// ============================================================================
// SCENARIO — instant-to-target hold (modeC-style cascade), single endpoint.
// PEAK overridable via env. Default 3000 (validated clean elsewhere).
// ============================================================================

const PEAK = parseInt(__ENV.PEAK || '3000', 10);
const DURATION = __ENV.DURATION || '5m';

export const options = {
  // `runner` keeps each distributed runner's Prometheus series distinct so the
  // 4 runners don't collide on identical labels (duplicate/out-of-order samples)
  // when remote-writing to the shared endpoint. K6_RUNNER_ID = runner pod name.
  tags: { testid: CONFIG.testId, version: 'v2', endpoint: 'inventory-stress', runner: __ENV.K6_RUNNER_ID || 'single' },
  scenarios: {
    inventory: {
      executor: 'ramping-arrival-rate',
      exec: 'sceneGetInventories',
      timeUnit: '1s',
      startRate: PEAK,
      preAllocatedVUs: 500,
      maxVUs: 8000,
      stages: [{ duration: DURATION, target: PEAK }],
    },
  },
  thresholds: {
    'http_req_failed':       ['rate<0.05'],
    'inventory_success_rate': ['rate>0.95'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ============================================================================
// METRICS
// ============================================================================

const inventoryDuration   = new Trend('inventory_duration');
const inventorySuccess    = new Rate('inventory_success_rate');
const skusRequested       = new Counter('skus_requested');

// ============================================================================
// HELPERS
// ============================================================================

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Store-Key': CONFIG.storeKey,
    'Accept-Encoding': 'gzip, br',
  };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Random sample of `count` distinct SKUs by index (cheap on a large list).
function sampleSkus(count) {
  const out = [];
  const seen = {};
  while (out.length < count) {
    const i = Math.floor(Math.random() * SKUS.length);
    if (!seen[i]) {
      seen[i] = true;
      out.push(SKUS[i]);
    }
  }
  return out;
}

// ============================================================================
// SCENE: GetInventories
// ============================================================================

export function sceneGetInventories() {
  const count = randomInt(MIN_BATCH, MAX_BATCH);
  const skus = sampleSkus(count);
  skusRequested.add(skus.length);

  const start = Date.now();
  const response = http.post(
    `${CONFIG.baseUrl}/api/inventories`,
    JSON.stringify({ skus }),
    { headers: getHeaders(), tags: { name: 'GetInventories' } }
  );
  inventoryDuration.add(Date.now() - start);

  const ok = check(response, { 'get inventories ok': (r) => r.status === 200 });
  inventorySuccess.add(ok);
}

// ============================================================================
// SUMMARY (stdout only — see header note on distributed runs)
// ============================================================================

export function handleSummary(data) {
  return {
    stdout: buildSummary(data),
  };
}

function buildSummary(data) {
  const m = data.metrics;
  const t = (name) => (m[name] ? m[name].values : {});
  const fmt = (v) => (v === undefined ? 'n/a' : Math.round(v) + 'ms');

  const inv = t('inventory_duration');
  const reqs = t('http_reqs');
  const failed = t('http_req_failed');
  const succ = t('inventory_success_rate');
  const skuc = t('skus_requested');

  let out = '\n========================================\n';
  out += '  Inventory Stress v2 - Summary (per runner)\n';
  out += '========================================\n\n';
  out += `Target:        ${PEAK} req/s for ${DURATION}\n`;
  out += `SKU pool:      ${SKUS.length}  (batch ${MIN_BATCH}-${MAX_BATCH}/req)\n`;
  out += `Throughput:    ${reqs.rate ? reqs.rate.toFixed(1) : 'n/a'} req/s  (${reqs.count || 0} total)\n`;
  out += `SKUs queried:  ${skuc.count || 0}\n\n`;
  out += `GetInventories latency:\n`;
  out += `  avg=${fmt(inv.avg)}  p90=${fmt(inv['p(90)'])}  p95=${fmt(inv['p(95)'])}  p99=${fmt(inv['p(99)'])}  max=${fmt(inv.max)}\n\n`;
  out += `Inventory success: ${succ.rate !== undefined ? (succ.rate * 100).toFixed(2) + '%' : 'n/a'}\n`;
  out += `HTTP req failed:   ${failed.rate !== undefined ? (failed.rate * 100).toFixed(3) + '%' : 'n/a'}\n`;
  out += '========================================\n';
  return out;
}
