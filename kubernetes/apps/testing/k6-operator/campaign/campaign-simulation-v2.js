import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import { SharedArray } from "k6/data";

// ============================================================================
// CAMPAIGN SIMULATION — v2 (dev2)
//
// Realistic mixed workload mirroring prod top-endpoint distribution from
// Sentry (7-day). Weights normalised to v2-relevant endpoints only.
//
// Mode A: fixed 4 replicas (capacity test) — uncomment scenarios.modeA below,
//         apply terraform to pin replicas, run, then restore terraform
// Mode B: autoscaling enabled (campaign-shape ramp) — uncomment scenarios.modeB,
//         normal terraform, longer ramp to test KEDA behaviour
//
// ONLY ONE MODE AT A TIME. Comment the other.
// ============================================================================

const CONFIG = {
  // Injected from the SOPS secret (k6-secrets) via runner env so the dilling
  // endpoint + store key aren't published in this public repo — a fork can't
  // decrypt them, so its runners have no valid target. NOT a security boundary
  // (values remain in git history; lock down dev2 access for that).
  baseUrl: __ENV.K6_BASE_URL || "",
  storeKey: __ENV.K6_STORE_KEY || "",
  testId:
    __ENV.TEST_ID || new Date().toISOString().slice(0, 16).replace("T", "_"),
  cartPoolSize: 1000,
  skus: [
    "5720588440030",
    "5720588444083",
    "5720588496884",
    "5720588436576",
    "5720588423149",
    "5720588423460",
    "5720588481514",
    "5720588481521",
    "5720588481538",
    "5720588481545",
    "5720588481552",
    "5720588436224",
    "5720588496532",
    "5720588496563",
    "5720588496570",
    "5720588474196",
    "5720588474202",
    "5720588474219",
    "5720588474226",
    "5720588440863",
    "5720588440894",
    "5720588440917",
    "5720588455706",
    "5720588455720",
    "5720588488704",
    "5720588488711",
    "5720588488728",
    "5720588440924",
    "5720588440931",
    "5720588440948",
    "5720588440955",
    "5720588440962",
    "5720588440979",
    "5720588488766",
    "5720588488773",
    "5720588488780",
    "5720588488797",
    "5720588488810",
    "5720588489022",
    "5720588489039",
    "5720588489046",
    "5720588489053",
    "5720588489060",
    "5720588489077",
    "5720588488841",
  ],
  productUrls: [
    "/produkt/beanie-i-merinould-fg-0905-0190-725",
    "/produkt/beanie-i-merinould-fg-9907-0190-265",
    "/produkt/beanie-i-merinould-fg-9907-0190-999",
    "/produkt/bluse-i-merinould-med-nordisk-monster-til-maend-fg-9942-0112-076",
    "/produkt/bluse-i-merinould-til-maend-fg-9927-0412-999",
    "/produkt/bluse-i-merinould-til-maend-fg-9927-0612-058",
    "/produkt/bluse-i-merinouldsilke-til-maend-fg-9952-0412-856",
    "/produkt/bluse-i-merinouldsilke-til-maend-fg-9952-0412-999",
    "/produkt/bluse-med-lynlaas-i-merinould-til-maend-fg-9927-0315-678",
    "/produkt/boxershorts-i-bomuld-til-maend-fg-3000-0337-999",
    "/produkt/cargopants-i-bomuld-til-maend-pg-9987-0155-057",
    "/produkt/cargopants-i-bomuld-til-maend-pg-9987-0155-278",
    "/produkt/elefanthue-i-merinould-til-maend-fg-9927-0293-058",
    "/produkt/elefanthue-i-merinould-til-maend-fg-9927-0293-678",
    "/produkt/flannelskjorte-i-bomulduld-til-maend-pg-61000-0100-190",
    "/produkt/flannelskjorte-i-bomulduld-til-maend-pg-61000-0100-198",
    "/produkt/haettetroje-i-bomuld-til-maend-pg-9987-0118-057",
    "/produkt/haettetroje-i-bomuld-til-maend-pg-9987-0118-278",
    "/produkt/haettetroje-i-merinould-til-maend-fg-9927-0218-999",
    "/produkt/haettetroje-med-lommer-i-merinouldfrotte-til-maend-fg-9925-0318-281",
    "/produkt/haettetroje-med-lommer-i-merinouldfrotte-til-maend-fg-9925-0318-999",
    "/produkt/half-zip-jakke-i-merinouldfleece-til-maend-fg-9937-0415-297",
    "/produkt/half-zip-jakke-i-merinouldfleece-til-maend-fg-9937-0415-597",
    "/produkt/half-zip-jakke-i-merinouldfleece-til-maend-fg-9937-0415-997",
    "/produkt/halsedisse-i-merinould-til-maend-fg-9927-0297-058",
    "/produkt/halsedisse-i-merinould-til-maend-fg-9927-0297-678",
    "/produkt/jakke-i-merinouldfleece-til-maend-fg-9937-0215-161",
    "/produkt/jakke-i-merinouldfleece-til-maend-fg-9937-0215-997",
    "/produkt/jakke-i-merinouldfleece-til-maend-fg-9937-0216-597",
    "/produkt/klassiske-boksershorts-i-bomuld-til-maend-3-pak-bu-3000-0237-199",
    "/produkt/klassiske-boxershorts-i-merinould-til-maend-fg-9927-0237-678",
    "/produkt/klassiske-underbukser-med-gylp-i-bomuld-til-maend-fg-1074-0203-999",
    "/produkt/lange-boxershorts-med-gylp-i-bomuld-til-maend-fg-1074-0238-999",
    "/produkt/lange-underbukser-i-merinould-med-nordisk-monster-til-maend-fg-9942-0148-076",
    "/produkt/lange-underbukser-i-merinould-til-maend-fg-9927-0548-112",
    "/produkt/lange-underbukser-i-merinould-til-maend-fg-9927-0548-678",
    "/produkt/lange-underbukser-i-merinould-til-maend-fg-9927-0548-999",
    "/produkt/pandebaand-i-merinould-til-maend-fg-9927-0195-112",
    "/produkt/pandebaand-i-merinould-til-maend-fg-9927-0195-678",
    "/produkt/sweatpants-i-bomuld-til-maend-pg-9987-0255-057",
    "/produkt/sweatpants-i-bomuld-til-maend-pg-9987-0255-278",
    "/produkt/sweatpants-i-merinould-til-maend-fg-9931-0155-999",
    "/produkt/sweatshirt-i-merinould-til-maend-fg-9931-0112-112",
    "/produkt/sweatshirt-i-merinould-til-maend-fg-9931-0112-999",
    "/produkt/sweatshirt-i-merinouldfrotte-til-maend-fg-9925-0212-281",
    "/produkt/sweatshirt-i-merinouldfrotte-til-maend-fg-9925-0212-568",
    "/produkt/t-shirt-i-bomuld-til-maend-fg-1050-0102-904",
    "/produkt/t-shirt-i-merinould-til-maend-fg-9916-0102-655",
    "/produkt/t-shirt-i-merinould-til-maend-fg-9927-0802-678",
    "/produkt/t-shirt-i-merinould-til-maend-fg-9927-0802-999",
  ],
};

// ============================================================================
// SCENARIOS
//
// Traffic mix matching prod Sentry data (v2-relevant subset, normalised):
//   GetCart           50%  (1.2M/7d, no cache, hits CT directly)
//   GetInventories    30%  (940K/7d, 120s Redis cache)
//   GetProductByUrl   15%  (154K/7d, parallel CT calls after recent opt)
//   Purchase flow      5%  (50K AddLine/7d ≈ 5% of cart reads)
//
// Select mode via MODE env var:
//   MODE=modeA: capacity test at fixed replicas (15 min, 200 → 800 req/s)
//   MODE=modeB: campaign-shape ramp with autoscaling (30 min, 200 → 1200 req/s)
//   MODE=modeC: cold-start cascade — instant 4 → 4000 req/s (5 min, no ramp)
// ============================================================================

const MODE = __ENV.MODE || "modeA";

const PROFILES = {
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
  // 1200 req/s immediately against a cold cluster sitting at min replicas.
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
  throw new Error(`Unknown MODE '${MODE}'. Use MODE=modeA, modeB, or modeC.`);
}

function rateFor(weight, totalRps) {
  return Math.max(1, Math.round(totalRps * weight));
}

function purchaseIterRate(weight, totalRps) {
  // 1 purchase iteration ≈ 12 HTTP requests, so iter rate ≈ req rate / 12
  return Math.max(1, Math.round(rateFor(weight, totalRps) / 12));
}

function buildStages(weight, mapper) {
  return profile.stages.map((rps) => ({
    duration: profile.stageDuration,
    target: mapper(weight, rps),
  }));
}

const W_CART = 0.5;
const W_INVENTORY = 0.3;
const W_PRODUCT = 0.15;
const W_PURCHASE = 0.05;

const firstStageRps = profile.stages[0];

export const options = {
  tags: {
    testid: CONFIG.testId,
    version: "v2",
    endpoint: "campaign-simulation",
    mode: MODE,
    // Distinct per-runner label so the distributed runners don't collide on
    // identical Prometheus series (K6_RUNNER_ID = runner pod name).
    runner: __ENV.K6_RUNNER_ID || "single",
  },
  scenarios: {
    cart: {
      executor: "ramping-arrival-rate",
      exec: "sceneGetCart",
      timeUnit: "1s",
      startRate: rateFor(W_CART, firstStageRps),
      preAllocatedVUs: 200,
      maxVUs: 6000,
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
    product: {
      executor: "ramping-arrival-rate",
      exec: "sceneGetProductByUrl",
      timeUnit: "1s",
      startRate: rateFor(W_PRODUCT, firstStageRps),
      preAllocatedVUs: 100,
      maxVUs: 4000,
      stages: buildStages(W_PRODUCT, rateFor),
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
const purchaseFlowDuration = new Trend("purchase_flow_duration");
const createCartDuration = new Trend("create_cart_duration");
const addLineDuration = new Trend("add_line_duration");
const updateLineDuration = new Trend("update_line_duration");
const deleteLineDuration = new Trend("delete_line_duration");
const addressDuration = new Trend("address_duration");
const flowSuccessRate = new Rate("flow_success_rate");
const setupCartsCreated = new Counter("setup_carts_created");

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

// Realistic cart-shape distribution: 70% small (2-4), 25% medium (5-10), 5% impulse (1)
function pickLineCount() {
  const r = Math.random();
  if (r < 0.05) {
    return 1;
  }
  if (r < 0.75) {
    return randomInt(2, 4);
  }
  return randomInt(5, 10);
}

// ============================================================================
// SETUP — generate 1000 empty carts in parallel batches
// ============================================================================

export function setup() {
  const startUtc = new Date().toISOString();
  console.log("=".repeat(70));
  console.log("Campaign Simulation - v2 (dev2)");
  console.log(`Mode:         ${MODE} (peak ${profile.peak} req/s)`);
  console.log(`Test ID:      ${CONFIG.testId}`);
  console.log(`Base URL:     ${CONFIG.baseUrl}`);
  console.log(`Cart pool:    ${CONFIG.cartPoolSize} (empty)`);
  console.log(`Product URLs: ${CONFIG.productUrls.length}`);
  console.log(`SKU pool:     ${CONFIG.skus.length}`);
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
  return { startUtc, cartIds };
}

// ============================================================================
// SCENE: GetCart (50% of traffic)
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
// SCENE: GetInventories (30% of traffic)
// ============================================================================

export function sceneGetInventories() {
  const count = randomInt(1, CONFIG.skus.length);
  const shuffled = [...CONFIG.skus].sort(() => Math.random() - 0.5);
  const skus = shuffled.slice(0, count);

  const response = timed(inventoryDuration, () =>
    http.post(`${CONFIG.baseUrl}/api/inventories`, JSON.stringify({ skus }), {
      headers: getHeaders(),
      tags: { name: "GetInventories" },
    }),
  );
  check(response, { "get inventories ok": (r) => r.status === 200 });
}

// ============================================================================
// SCENE: GetProductByUrl (15% of traffic)
// ============================================================================

export function sceneGetProductByUrl() {
  const url =
    CONFIG.productUrls[Math.floor(Math.random() * CONFIG.productUrls.length)];
  const response = timed(productDuration, () =>
    http.get(`${CONFIG.baseUrl}/api/products?url=${encodeURIComponent(url)}`, {
      headers: getHeaders(),
      tags: { name: "GetProductByUrl" },
    }),
  );
  check(response, { "get product ok": (r) => r.status === 200 });
}

// ============================================================================
// SCENE: PurchaseFlow (5% of traffic, full anonymous checkout)
// ============================================================================

export function scenePurchaseFlow() {
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

  // Add 2-5 lines
  const lineCount = randomInt(2, 5);
  const lineIds = [];
  for (let i = 0; i < lineCount; i++) {
    const addRes = timed(addLineDuration, () =>
      http.post(
        `${CONFIG.baseUrl}/api/carts/${cartId}/lines`,
        JSON.stringify({ sku: randomSku(), quantity: 1 }),
        { headers: getHeaders(), tags: { name: "AddLine" } },
      ),
    );
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
    firstName: "Michael",
    lastName: "Sølvsteen",
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
  // stdout only — the runner pod FS is ephemeral, and distributed runs emit a
  // per-runner summary anyway; use pod logs + Grafana for the aggregate view.
  return {
    stdout: buildSummary(data),
  };
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
  out += "  Campaign Simulation v2 - Performance Summary\n";
  out += "========================================\n\n";
  out += `Start UTC:   ${startUtc}\n`;
  out += `End UTC:     ${endUtc}\n`;
  out += `Cart pool:   ${cartPoolSize}\n\n`;

  const sections = [
    ["GetCart            (50%)", "cart_duration"],
    ["GetInventories     (30%)", "inventory_duration"],
    ["GetProductByUrl    (15%)", "product_duration"],
    ["PurchaseFlow total ( 5%)", "purchase_flow_duration"],
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

  out += "========================================\n";
  return out;
}
