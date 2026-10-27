const { test } = require("node:test");
const assert = require("node:assert/strict");

const modulePromise = import("../supabase/functions/location-update/index.mjs");
const NOW = Date.parse("2026-10-26T16:00:00Z");
const TOKEN = "test-upload-token-0123456789abcdef";
const ENV = {
  LOCATION_UPLOAD_TOKEN: TOKEN,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key"
};
const VALID = { latitude: 42.28, longitude: -83.74, reported_at: "2026-10-26T12:00:00-04:00" };

function request(body = VALID, options = {}) {
  return new Request("https://example.supabase.co/functions/v1/location-update", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options
  });
}

async function setup({ env = ENV, save = async () => new Response("true") } = {}) {
  const { createLocationHandler } = await modulePromise;
  const calls = [];
  const handler = createLocationHandler({
    getEnv: (name) => env[name],
    now: () => NOW,
    fetchImpl: async (...args) => { calls.push(args); return save(...args); }
  });
  return { handler, calls };
}

test("location upload authenticates before reading or saving coordinates", async () => {
  const { handler, calls } = await setup();
  for (const token of [null, "Bearer wrong-token", "Basic abc"]) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = token;
    assert.equal((await handler(request(VALID, { headers }))).status, 401);
  }
  assert.equal(calls.length, 0);
});

test("location upload rejects absent or weak configuration and non-POST methods", async () => {
  for (const env of [{}, { ...ENV, LOCATION_UPLOAD_TOKEN: "short" }]) {
    const { handler, calls } = await setup({ env });
    assert.equal((await handler(request())).status, 503);
    assert.equal(calls.length, 0);
  }
  const { handler } = await setup();
  const response = await handler(new Request("https://example.test/"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});

test("location upload rejects malformed, oversized, or wrong-type bodies", async () => {
  const { handler, calls } = await setup();
  assert.equal((await handler(request(VALID, { body: "{" }))).status, 400);
  assert.equal((await handler(request(VALID, { body: " ".repeat(4097) }))).status, 413);
  assert.equal((await handler(request(VALID, {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" }
  }))).status, 415);
  for (const body of [null, [], {}, { ...VALID, latitude: "42.28" },
    { ...VALID, latitude: 91 }, { ...VALID, longitude: -181 }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("location upload rejects missing, ambiguous, old, and future timestamps", async () => {
  const { handler, calls } = await setup();
  for (const reported_at of [undefined, "not a date", "2026-10-26T16:00:00",
    "2026-10-25T15:59:59Z", "2026-10-26T16:05:01Z"]) {
    assert.equal((await handler(request({ ...VALID, reported_at }))).status, 400);
  }
  assert.equal(calls.length, 0);
});

test("location upload saves numeric coordinates and normalizes time without echoing location", async () => {
  const { handler, calls } = await setup();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, saved: true });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, `${ENV.SUPABASE_URL}/rest/v1/rpc/record_owner_location`);
  assert.equal(options.headers.Authorization, `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.deepEqual(JSON.parse(options.body), {
    p_latitude: VALID.latitude, p_longitude: VALID.longitude,
    p_reported_at: "2026-10-26T16:00:00.000Z"
  });
  assert.ok(options.signal instanceof AbortSignal);
});

test("location upload accepts zero coordinates and acknowledges ignored stale/duplicate writes", async () => {
  const { handler } = await setup({ save: async () => new Response("false") });
  const response = await handler(request({ ...VALID, latitude: 0, longitude: 0 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, saved: false });
});

test("location upload never claims success or leaks upstream details on persistence failures", async () => {
  for (const save of [
    async () => new Response("private database details", { status: 500 }),
    async () => { throw new Error("private network details"); },
    async () => new Response("not JSON"),
    async () => new Response("null")
  ]) {
    const { handler } = await setup({ save });
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Could not save location. Try again later." });
  }
});
