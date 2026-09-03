import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import { SharedArray } from "k6/data";

// ============================================================================
// CAMPAIGN SIMULATION — v2, product fetch by SKU (product key)
//
// Reweighted against measured prod v2 traffic — see SCENARIOS below. Two ways
// it differs from campaign-simulation-v2.js, so results are NOT comparable:
//
//  - The product fetch uses GET /api/products/sku/{sku}, the route the v2
//    frontend actually calls. The deprecated GET /api/products?url=... is gone
//    (zero prod traffic in the last 24h). By-key skips the per-variant
//    attribute resolution by-url needed to verify the URL.
//  - The mix is real: PDP + inventory are ~95% of prod requests, and cart
//    reads are 1%, not the 50% the old script assumed from v1 data.
//
// No product or review query is cacheable per-request, so cache behaviour is
// unchanged — this workload is CT-bound by design.
//
// TARGET IS PRODUCTION. The default baseUrl is the prod Front Door, and the
// pools are prod data. The purchase flow creates real anonymous carts in prod
// commercetools (lines + addresses); it stops before payment, so no orders and
// no Adyen calls. There is no CT Subscription on Cart, so nothing reaches
// Service Bus, Klaviyo or Business Central from these carts — they are inert
// clutter that expires with CT's cart TTL. Point K6_BASE_URL elsewhere to
// avoid that.
//
// Config comes from env so the same file runs locally and on the k6-operator
// runners (SOPS-injected K6_BASE_URL / K6_STORE_KEY).
//
// Local:   k6 run -e MODE=modeA k6-tests/campaign-simulation-v2-by-key.js
// Cluster: MODE + K6_BASE_URL + K6_STORE_KEY + K6_RUNNER_ID from the runner
// ============================================================================

// Pools live beside the script; k6-operator mounts the whole ConfigMap flat
// into /test/, so these relative paths resolve on the runners too. SharedArray
// keeps ONE copy per pod instead of one per VU — at 8000 maxVUs an inline array
// of 4402 EANs would otherwise be duplicated 8000 times.
//
// eans.json: CT variant SKUs, used for /api/inventories and AddLine.
// skus.json: CT product keys, used for the PDP scene.
const EANS = new SharedArray("eans", function () {
  return JSON.parse(open("./eans.json"));
});

const SKUS = new SharedArray("skus", function () {
  return JSON.parse(open("./skus.json"));
});

const CONFIG = {
  baseUrl: __ENV.K6_BASE_URL,
  storeKey: __ENV.K6_STORE_KEY,
  testId:
    __ENV.TEST_ID || new Date().toISOString().slice(0, 16).replace("T", "_"),
  cartPoolSize: Number(__ENV.K6_CART_POOL || 1000),

  // Max EANs per /api/inventories request — the pool is far bigger than any
  // real PLP page, so cap the payload instead of slicing the whole pool.
  inventoryBatchMax: 45,

  // How many EANs setup() probes for AddLine-ability (one request each, once
  // per runner pod). About 1 in 6 passes, so 180 yields ~30 usable EANs.
  eanProbeSize: 180,

  // Fresh probe cart every N probes — AddLine returns the whole cart, so a
  // single cart accumulating 180 lines makes each probe slower than the last.
  eanProbeCartEvery: 30,

  // Alternative EANs to try per cart line before giving up on it.
  addLineAttempts: 3,
  // EANs = CT variant SKUs. Used for /api/inventories and AddLine (the API's
  // `sku` request field carries the EAN — InventoryGetByVariantsQuery).
  // Pool lives in ./eans.json — see EANS above.
  eans: EANS,

  // SKUs = CT product keys, always uppercase in CT. Every product in the live
  // da-DK sitemap (dk.dilling.com/sitemap/products/sitemap/da-DK_0.xml) — the
  // key is the last 4 dash segments of the slug. The PDP scene therefore mixes
  // populated and empty review responses in about the real proportion.
  // Pool lives in ./skus.json — see SKUS above.
  skus: SKUS,
};

// ============================================================================
// SCENARIOS
//
// Traffic mix measured from prod Prometheus (http_server_request_duration_
// seconds_count, deployment_environment=Production, 7d to 2026-09-02 —
// 15.0M requests total), normalised over the storefront routes:
//
//   PDP view          62%  products/sku 4.43M/7d + key/{key}/reviews 4.77M/7d.
//                          Fired together per page view, so one iteration
//                          batches both — that is what the browser does.
//   GetInventories    33%  4.85M/7d, 120s Redis cache, L1 bypassed
//   Purchase flow      4%  lines/addresses/payments ≈ 450K/7d combined
//   GetCart            1%  176K/7d — the v2 frontend does not poll the cart,
//                          unlike v1 (this was 50% in the older script)
//
// Select mode via MODE env var:
//   MODE=modeA: capacity test (15 min, 1000 → 3000 req/s)
//   MODE=modeB: campaign-shape ramp with autoscaling (30 min, 400 → 1200 req/s)
//   MODE=modeC: cold-start cascade — instant 4000 req/s (5 min, no ramp)
// ============================================================================

const MODE = __ENV.MODE || "modeC";

const PROFILES = {
  // Pre-flight: proves every scene and both pools work before committing to a
  // real run. Pair with a small pool: MODE=smoke -e K6_CART_POOL=20
  smoke: {
    peak: 20,
    stages: [20],
    stageDuration: "20s",
  },
  modeA: {
    peak: 3000,
    stages: [1000, 1500, 2000, 3000, 3000],
    stageDuration: "3m",
  },
  modeB: {
    peak: 1200,
    stages: [400, 600, 800, 1000, 1200, 1200],
    stageDuration: "5m",
  },
  // modeC: simulates the 2025/2026 prod cascade pattern. No ramp — k6 fires
  // 4000 req/s immediately against a cold cluster sitting at min replicas.
  // Tests KEDA reactivity + cold-start latency + Front Door queue behaviour
  // under the actual failure mode that brought down v1 in prior campaigns.
  modeC: {
    peak: 4000,
    stages: [4000],
    stageDuration: "5m",
  },
};

const profile = PROFILES[MODE];
if (!profile) {
  throw new Error(
    `Unknown MODE '${MODE}'. Use MODE=smoke, modeA, modeB, or modeC.`,
  );
}

function rateFor(weight, totalRps) {
  return Math.max(1, Math.round(totalRps * weight));
}

function purchaseIterRate(weight, totalRps) {
  // 1 purchase iteration ≈ 12 HTTP requests, so iter rate ≈ req rate / 12
  return Math.max(1, Math.round(rateFor(weight, totalRps) / 12));
}

function pdpIterRate(weight, totalRps) {
  // 1 PDP iteration = 2 batched requests (product + reviews)
  return Math.max(1, Math.round(rateFor(weight, totalRps) / 2));
}

function buildStages(weight, mapper) {
  return profile.stages.map((rps) => ({
    duration: profile.stageDuration,
    target: mapper(weight, rps),
  }));
}

const W_PDP = 0.62;
const W_INVENTORY = 0.33;
const W_PURCHASE = 0.04;
const W_CART = 0.01;

const firstStageRps = profile.stages[0];

export const options = {
  tags: {
    testid: CONFIG.testId,
    version: "v2",
    endpoint: "campaign-simulation",
    mode: MODE,
    // Distinct per-runner label so distributed runners don't collide on
    // identical Prometheus series (K6_RUNNER_ID = runner pod name).
    runner: __ENV.K6_RUNNER_ID || "single",
  },
  scenarios: {
    cart: {
      executor: "ramping-arrival-rate",
      exec: "sceneGetCart",
      timeUnit: "1s",
      startRate: rateFor(W_CART, firstStageRps),
      preAllocatedVUs: 30,
      maxVUs: 1000,
      stages: buildStages(W_CART, rateFor),
    },
    inventory: {
      executor: "ramping-arrival-rate",
      exec: "sceneGetInventories",
      timeUnit: "1s",
      startRate: rateFor(W_INVENTORY, firstStageRps),
      preAllocatedVUs: 100,
      maxVUs: 4000,
      stages: buildStages(W_INVENTORY, rateFor),
    },
    pdp: {
      executor: "ramping-arrival-rate",
      exec: "scenePdp",
      timeUnit: "1s",
      startRate: pdpIterRate(W_PDP, firstStageRps),
      preAllocatedVUs: 300,
      maxVUs: 8000,
      stages: buildStages(W_PDP, pdpIterRate),
    },
    purchase: {
      executor: "ramping-arrival-rate",
      exec: "scenePurchaseFlow",
      timeUnit: "1s",
      startRate: purchaseIterRate(W_PURCHASE, firstStageRps),
      preAllocatedVUs: 100,
      maxVUs: 3000,
      stages: buildStages(W_PURCHASE, purchaseIterRate),
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    flow_success_rate: ["rate>0.95"],
  },
  setupTimeout: "10m",
  summaryTrendStats: ["min", "avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// ============================================================================
// METRICS
// ============================================================================

const cartDuration = new Trend("cart_duration");
const inventoryDuration = new Trend("inventory_duration");
const productDuration = new Trend("product_duration");
const reviewsDuration = new Trend("reviews_duration");
const pdpDuration = new Trend("pdp_duration");
const purchaseFlowDuration = new Trend("purchase_flow_duration");
const createCartDuration = new Trend("create_cart_duration");
const addLineDuration = new Trend("add_line_duration");
const updateLineDuration = new Trend("update_line_duration");
const deleteLineDuration = new Trend("delete_line_duration");
const addressDuration = new Trend("address_duration");
const flowSuccessRate = new Rate("flow_success_rate");
const setupCartsCreated = new Counter("setup_carts_created");
const addLineNotActive = new Counter("add_line_not_active");

// ============================================================================
// HELPERS
// ============================================================================

function getHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Store-Key": CONFIG.storeKey,
    "Accept-Encoding": "gzip, br",
  };
}

function randomSku() {
  return CONFIG.skus[Math.floor(Math.random() * CONFIG.skus.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function timed(trend, fn) {
  const start = Date.now();
  const result = fn();
  trend.add(Date.now() - start);
  return result;
}

// ============================================================================
// SETUP — generate 1000 empty carts in parallel batches
// ============================================================================

export function setup() {
  if (!CONFIG.baseUrl) {
    throw new Error("No base URL. Set K6_BASE_URL.");
  }

  if (!CONFIG.storeKey) {
    throw new Error("No store key. Set K6_STORE_KEY.");
  }

  const startUtc = new Date().toISOString();
  console.log("=".repeat(70));
  console.log("Campaign Simulation - v2 (product fetch by SKU)");
  console.log(`Mode:         ${MODE} (peak ${profile.peak} req/s)`);
  console.log(`Test ID:      ${CONFIG.testId}`);
  console.log(`Base URL:     ${CONFIG.baseUrl}`);
  console.log(`Cart pool:    ${CONFIG.cartPoolSize} (empty)`);
  console.log(`SKU pool:     ${CONFIG.skus.length} (product keys)`);
  console.log(`EAN pool:     ${CONFIG.eans.length} (variant SKUs)`);
  console.log(`Start UTC:    ${startUtc}`);
  console.log("Generating cart pool in parallel batches...");
  console.log("=".repeat(70));

  const cartIds = [];
  let failed = 0;
  const batchSize = 20;
  const headers = getHeaders();

  for (let i = 0; i < CONFIG.cartPoolSize; i += batchSize) {
    const remaining = Math.min(batchSize, CONFIG.cartPoolSize - i);
    const requests = Array.from({ length: remaining }, () => ({
      method: "POST",
      url: `${CONFIG.baseUrl}/api/carts`,
      body: null,
      params: { headers },
    }));

    const responses = http.batch(requests);
    for (const res of responses) {
      if (res.status !== 200) {
        failed++;
        continue;
      }
      let cartId;
      try {
        cartId = JSON.parse(res.body).id;
      } catch {
        failed++;
        continue;
      }
      if (!cartId) {
        failed++;
        continue;
      }
      cartIds.push(cartId);
      setupCartsCreated.add(1);
    }

    if ((i + batchSize) % 100 === 0 || i + batchSize >= CONFIG.cartPoolSize) {
      console.log(
        `  ${cartIds.length}/${CONFIG.cartPoolSize} carts created (${failed} failures)`,
      );
    }
  }

  console.log(`Cart pool ready: ${cartIds.length} carts (${failed} failures)`);

  // `isOrderable` only means the variant has stock — plenty of those products
  // are not active in this store, and AddLine 404s with
  // CartAddLineProductNotFoundOrActive. There is no read endpoint that answers
  // "can this EAN be added", so probe a sample against one throwaway cart and
  // let the purchase flow use what actually worked.
  const addableEans = [];
  const offset = Math.floor(Math.random() * CONFIG.eans.length);
  let probeCartId = null;
  for (let i = 0; i < CONFIG.eanProbeSize; i++) {
    if (i % CONFIG.eanProbeCartEvery === 0) {
      const probeRes = http.post(`${CONFIG.baseUrl}/api/carts`, null, {
        headers,
      });
      if (probeRes.status !== 200) {
        break;
      }
      probeCartId = JSON.parse(probeRes.body).id;
    }

    const ean = CONFIG.eans[(offset + i) % CONFIG.eans.length];
    const res = http.post(
      `${CONFIG.baseUrl}/api/carts/${probeCartId}/lines`,
      JSON.stringify({ sku: ean, quantity: 1 }),
      {
        headers,
        tags: { name: "ProbeAddLine" },
        // A 404 is the expected answer for most probes, so don't let them
        // count against http_req_failed.
        responseCallback: http.expectedStatuses(200, 404),
      },
    );
    if (res.status === 200) {
      addableEans.push(ean);
    }
  }

  // null = fall back to the full EANS SharedArray in the scene. Returning
  // CONFIG.eans here would JSON-serialize 4402 entries into every VU's copy
  // of setup data, which is exactly what SharedArray exists to avoid.
  const purchaseEans = addableEans.length >= 5 ? addableEans : null;
  console.log(
    `Addable EANs: ${addableEans.length}/${CONFIG.eanProbeSize} probed` +
      `${addableEans.length < 5 ? " — too few, purchase flow falls back to the full pool" : ""}`,
  );

  return { startUtc, cartIds, purchaseEans };
}

// ============================================================================
// SCENE: GetCart (1% of traffic)
// ============================================================================

export function sceneGetCart(data) {
  const cartId = data.cartIds[Math.floor(Math.random() * data.cartIds.length)];
  const response = timed(cartDuration, () =>
    http.get(`${CONFIG.baseUrl}/api/carts/${cartId}`, {
      headers: getHeaders(),
      tags: { name: "GetCart" },
    }),
  );
  check(response, { "get cart ok": (r) => r.status === 200 });
}

// ============================================================================
// SCENE: GetInventories (33% of traffic)
// ============================================================================

export function sceneGetInventories() {
  // Contiguous window from a random offset: O(count) instead of shuffling 500+
  // entries per iteration, and adjacent EANs are the same product's sizes —
  // which is what a PLP actually asks for.
  const count = randomInt(1, CONFIG.inventoryBatchMax);
  const start = Math.floor(Math.random() * CONFIG.eans.length);
  const skus = [];
  for (let i = 0; i < count; i++) {
    skus.push(CONFIG.eans[(start + i) % CONFIG.eans.length]);
  }

  const response = timed(inventoryDuration, () =>
    http.post(`${CONFIG.baseUrl}/api/inventories`, JSON.stringify({ skus }), {
      headers: getHeaders(),
      tags: { name: "GetInventories" },
    }),
  );
  check(response, { "get inventories ok": (r) => r.status === 200 });
}

// ============================================================================
// SCENE: PDP view (62% of traffic — 2 requests per iteration)
//
// A real product page fires the product fetch and its review summary together
// for the same key, so they go out in one batch rather than as two independent
// scenarios. Neither is cached per-request: the product query hits CT twice
// (GetByKey + GetByModel) and the review query hits CT once (only the approved-
// state lookup is cached), so this is the expensive half of the workload.
// ============================================================================

export function scenePdp() {
  const sku = randomSku();
  const headers = getHeaders();
  const start = Date.now();

  const responses = http.batch([
    {
      method: "GET",
      url: `${CONFIG.baseUrl}/api/products/sku/${sku}`,
      params: { headers, tags: { name: "GetProductBySku" } },
    },
    {
      method: "GET",
      url: `${CONFIG.baseUrl}/api/products/key/${sku}/reviews`,
      params: { headers, tags: { name: "GetProductReviews" } },
    },
  ]);

  pdpDuration.add(Date.now() - start);
  productDuration.add(responses[0].timings.duration);
  reviewsDuration.add(responses[1].timings.duration);

  check(responses[0], { "get product ok": (r) => r.status === 200 });
  check(responses[1], { "get reviews ok": (r) => r.status === 200 });
}

// ============================================================================
// SCENE: PurchaseFlow (4% of traffic, full anonymous checkout)
// ============================================================================

export function scenePurchaseFlow(data) {
  const eans = data.purchaseEans || EANS;
  const flowStart = Date.now();

  // Create cart
  const createRes = timed(createCartDuration, () =>
    http.post(`${CONFIG.baseUrl}/api/carts`, null, {
      headers: getHeaders(),
      tags: { name: "CreateCart" },
    }),
  );
  if (createRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  let cartId;
  try {
    cartId = JSON.parse(createRes.body).id;
  } catch {
    flowSuccessRate.add(false);
    return;
  }
  if (!cartId) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(0.5);

  // Add 2-5 lines. A 404 here is CartAddLineProductNotFoundOrActive — the EAN
  // has stock but its product is not active in this store. Real shoppers never
  // hit that (they add from a page that exists), so treat it as a bad pick and
  // try another EAN instead of failing the checkout.
  const lineCount = randomInt(2, 5);
  const lineIds = [];
  for (let i = 0; i < lineCount; i++) {
    let addRes = null;
    for (let attempt = 0; attempt < CONFIG.addLineAttempts; attempt++) {
      const ean = eans[Math.floor(Math.random() * eans.length)];
      addRes = timed(addLineDuration, () =>
        http.post(
          `${CONFIG.baseUrl}/api/carts/${cartId}/lines`,
          JSON.stringify({ sku: ean, quantity: 1 }),
          { headers: getHeaders(), tags: { name: "AddLine" } },
        ),
      );
      if (addRes.status !== 404) {
        break;
      }
      addLineNotActive.add(1);
    }

    if (addRes.status !== 200) {
      flowSuccessRate.add(false);
      return;
    }
    try {
      const lines = JSON.parse(addRes.body)?.lineItems;
      const id = lines?.length > 0 ? lines[lines.length - 1].id : null;
      if (!id) {
        flowSuccessRate.add(false);
        return;
      }
      lineIds.push(id);
    } catch {
      flowSuccessRate.add(false);
      return;
    }
    sleep(0.5);
  }

  // Update first line
  const updateRes = timed(updateLineDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/lines/${lineIds[0]}`,
      JSON.stringify({ quantity: randomInt(2, 3) }),
      { headers: getHeaders(), tags: { name: "UpdateLine" } },
    ),
  );
  if (updateRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(0.5);

  // Delete last line
  const deleteRes = timed(deleteLineDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/lines/${lineIds[lineIds.length - 1]}`,
      JSON.stringify({ quantity: 0 }),
      { headers: getHeaders(), tags: { name: "DeleteLine" } },
    ),
  );
  if (deleteRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(0.5);

  // Address details (email-only then full)
  const emailOnly = { email: "mhs@dilling.com", country: "DK" };
  const addrEmailRes = timed(addressDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/customer-address`,
      JSON.stringify(emailOnly),
      { headers: getHeaders(), tags: { name: "UpdateCustomerAddress" } },
    ),
  );
  if (addrEmailRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(0.5);
  const shipEmailRes = timed(addressDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/shipping-address`,
      JSON.stringify(emailOnly),
      { headers: getHeaders(), tags: { name: "UpdateShippingAddress" } },
    ),
  );
  if (shipEmailRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(1);

  const fullAddress = {
    firstName: "Test",
    lastName: "Testesen",
    streetName: "Sundsvej 62",
    streetNumber: "Nybo",
    postalCode: "7400",
    city: "Herning",
    country: "DK",
    phone: "12345678",
  };
  const addrFullRes = timed(addressDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/customer-address`,
      JSON.stringify(fullAddress),
      { headers: getHeaders(), tags: { name: "UpdateCustomerAddress" } },
    ),
  );
  if (addrFullRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }
  sleep(0.5);
  const shipFullRes = timed(addressDuration, () =>
    http.patch(
      `${CONFIG.baseUrl}/api/carts/${cartId}/shipping-address`,
      JSON.stringify(fullAddress),
      { headers: getHeaders(), tags: { name: "UpdateShippingAddress" } },
    ),
  );
  if (shipFullRes.status !== 200) {
    flowSuccessRate.add(false);
    return;
  }

  purchaseFlowDuration.add(Date.now() - flowStart);
  flowSuccessRate.add(true);
}

// ============================================================================
// SUMMARY
// ============================================================================

export function handleSummary(data) {
  const out = { stdout: buildSummary(data) };

  // Runner pods have an ephemeral FS and each emits its own per-runner summary,
  // so only write the JSON when running locally (pod logs + Grafana on cluster).
  if (!__ENV.K6_RUNNER_ID) {
    out[`k6-tests/results/campaign-simulation-v2-by-key-${MODE}-results.json`] =
      JSON.stringify(data);
  }

  return out;
}

function buildSummary(data) {
  const m = data.metrics;
  const startUtc =
    data.setup_data && data.setup_data.startUtc
      ? data.setup_data.startUtc
      : "n/a";
  const endUtc = new Date().toISOString();
  const cartPoolSize =
    data.setup_data && data.setup_data.cartIds
      ? data.setup_data.cartIds.length
      : 0;

  let out = "\n========================================\n";
  out += "  Campaign Simulation v2 (by SKU) - Performance Summary\n";
  out += "========================================\n\n";
  out += `Mode:        ${MODE}\n`;
  out += `Start UTC:   ${startUtc}\n`;
  out += `End UTC:     ${endUtc}\n`;
  out += `Cart pool:   ${cartPoolSize}\n\n`;

  const sections = [
    ["PDP view total     (62%)", "pdp_duration"],
    ["  GetProductBySku      ", "product_duration"],
    ["  GetProductReviews    ", "reviews_duration"],
    ["GetInventories     (33%)", "inventory_duration"],
    ["PurchaseFlow total ( 4%)", "purchase_flow_duration"],
    ["GetCart            ( 1%)", "cart_duration"],
  ];
  for (const [label, key] of sections) {
    if (m[key]) {
      const v = m[key].values;
      out += `${label}:\n`;
      out += `  avg=${v.avg.toFixed(0)}ms  p95=${v["p(95)"].toFixed(0)}ms  p99=${v["p(99)"].toFixed(0)}ms\n`;
    }
  }

  out += "\nPurchase flow steps:\n";
  const steps = [
    ["  Create cart       ", "create_cart_duration"],
    ["  Add line          ", "add_line_duration"],
    ["  Update line       ", "update_line_duration"],
    ["  Delete line       ", "delete_line_duration"],
    ["  Address (each)    ", "address_duration"],
  ];
  for (const [label, key] of steps) {
    if (m[key]) {
      const v = m[key].values;
      out += `${label}: avg=${v.avg.toFixed(0)}ms  p95=${v["p(95)"].toFixed(0)}ms\n`;
    }
  }

  if (m.http_reqs) {
    out += `\nTotal throughput: ${m.http_reqs.values.rate.toFixed(2)} req/s (${m.http_reqs.values.count} total)\n`;
  }
  if (m.http_req_failed) {
    out += `Error rate: ${(m.http_req_failed.values.rate * 100).toFixed(3)}%\n`;
  }
  if (m.flow_success_rate) {
    out += `Purchase flow success: ${(m.flow_success_rate.values.rate * 100).toFixed(2)}%\n`;
  }
  if (m.add_line_not_active) {
    out += `AddLine retries (product not active in store): ${m.add_line_not_active.values.count}\n`;
  }

  out += "========================================\n";
  return out;
}
