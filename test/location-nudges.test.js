"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
for (const name of ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) process.env[name] = "test";
Object.assign(process.env, {
  TELEGRAM_CHAT_ID: "1", SUPABASE_URL: "https://example.supabase.co",
  GOOGLE_CALENDAR_IDS: "primary", GOOGLE_MAPS_API_KEY: "test-maps-key",
  LOCATION_AWARE_NUDGES: "true", DEBUG: "false"
});
const { buildLocationContext, coordinateDistanceMeters, normalizeNearbyPlaces,
  normalizeOwnerLocation, parseLocationNudgeResponse, runNudgeTick } = require("../server.js");
const NOW = Date.parse("2026-10-26T22:00:00Z"); // 15:00 Pacific, inside the send window
const LOCATION = { latitude: 42.28, longitude: -83.74,
  reported_at: "2026-10-26T21:55:00Z", received_at: "2026-10-26T21:55:01Z" };
const PLACES = [{ id: "library-1", displayName: { text: "Library" },
  location: { latitude: 42.2801, longitude: -83.74 }, primaryType: "library", types: ["library"] }];
const TASK = { id: "task-1", title: "Read a chapter", urgency: 5, duration: 30 };
const DECISION = { send: true, confidence: "high", reason: "suitable",
  explanation: "Limited movement and a study-friendly setting suit the selected work.",
  message: "If you’re up for it, you could read a chapter.", placeIds: ["library-1"] };

function assessment(decision = DECISION) {
  return { stop_reason: "tool_use", content: [
    { type: "tool_use", name: "submit_nudge_decision", id: "decision-1", input: decision }
  ] };
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const calls = [];
  calls.decisionLogs = [];
  t.mock.method(console, "log", (prefix, entry) => {
    if (prefix === "[nudge-decision]") calls.decisionLogs.push(JSON.parse(entry));
  });
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    const body = typeof init.body === "string" && init.body.startsWith("{")
      ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method, body, signal: init.signal, headers: init.headers });
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "test-google-token", expires_in: 3600 });
    }
    if (url.pathname.includes("/calendar/v3/")) return Response.json({ items: options.events || [] });
    if (url.pathname === "/rest/v1/nudges") {
      return Response.json(method === "GET" ? (options.nudges || []) : null);
    }
    if (url.pathname === "/rest/v1/tasks") return Response.json(options.tasks || [TASK]);
    if (url.pathname === "/rest/v1/owner_location") {
      return Response.json(options.location === undefined ? LOCATION : options.location);
    }
    if (url.pathname === "/v1/places:searchNearby") {
      return options.mapsError ? Response.json({ error: "private upstream details" }, { status: 403 })
        : Response.json(options.mapsData || { places: PLACES });
    }
    if (url.pathname === "/v1/messages") {
      options.onAssessment?.();
      if (options.anthropicError) throw new Error("Do not expose request details");
      return Response.json(options.response || assessment());
    }
    if (url.hostname === "api.telegram.org") {
      if (options.telegramError) throw new Error("private telegram request details");
      return Response.json({ ok: true, result: {} });
    }
    if (url.pathname === "/rest/v1/chat_messages") return Response.json(null);
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return calls;
}

const count = (calls, path, method) => calls.filter((call) =>
  call.path === path && (!method || call.method === method)).length;

test("location freshness checks both report and receipt time without coercing coordinates", () => {
  const now = new Date(NOW);
  assert.ok(normalizeOwnerLocation(LOCATION, now));
  assert.ok(normalizeOwnerLocation({ ...LOCATION, latitude: 0, longitude: 0 }, now));
  for (const row of [null, { ...LOCATION, latitude: "42.28" }, { ...LOCATION, longitude: 181 },
    { ...LOCATION, latitude: NaN }, { ...LOCATION, reported_at: null },
    { ...LOCATION, reported_at: "2026-10-26T21:39:59Z" },
    { ...LOCATION, reported_at: "2026-10-26T22:05:01Z" },
    { ...LOCATION, received_at: "2026-10-26T21:39:59Z" }]) {
    assert.equal(normalizeOwnerLocation(row, now), null);
  }
});

test("trail measurements describe a cluster without inventing a settled status or minimum wait", () => {
  const row = { ...LOCATION, trail: [
    { ...LOCATION, latitude: 42.2801, reported_at: "2026-10-26T21:35:00Z", received_at: "2026-10-26T21:35:01Z" },
    { ...LOCATION, latitude: 42.28005, reported_at: "2026-10-26T21:45:00Z", received_at: "2026-10-26T21:45:01Z" },
    LOCATION
  ] };
  const context = buildLocationContext(row, new Date(NOW));
  assert.equal(context.trail.report_count, 3);
  assert.equal(context.trail.observed_minutes, 20);
  assert.equal(context.trail.maximum_separation_meters, 11);
  assert.equal(context.trail.segments.length, 2);
  assert.equal(context.trail.segments[0].elapsed_minutes, 10);
  assert.equal(context.trail.settled, undefined);
  assert.equal(context.trail.moving, undefined);
  assert.equal(buildLocationContext(LOCATION, new Date(NOW)).trail.report_count, 1);
});

test("trail detects sampled travel out and back despite zero net displacement", () => {
  const context = buildLocationContext({ ...LOCATION, trail: [
    { ...LOCATION, reported_at: "2026-10-26T21:35:00Z", received_at: "2026-10-26T21:35:01Z" },
    { ...LOCATION, latitude: 42.29, reported_at: "2026-10-26T21:45:00Z", received_at: "2026-10-26T21:45:01Z" }
  ] }, new Date(NOW));
  assert.equal(context.trail.net_displacement_meters, 0);
  assert.ok(context.trail.maximum_separation_meters > 1100);
  assert.ok(context.trail.sampled_path_meters > 2200);
  assert.ok(context.trail.segments.every((segment) => segment.displacement_rate_kmh > 6));
});

test("trail discards malformed, delayed, duplicated, stale, and future historical reports", () => {
  const old = { ...LOCATION, reported_at: "2026-10-26T21:45:00Z", received_at: "2026-10-26T21:45:01Z" };
  const context = buildLocationContext({ ...LOCATION, trail: [
    old, old,
    { ...old, latitude: "42.28" },
    { ...old, reported_at: "2026-10-26T21:00:00Z" },
    { ...old, reported_at: "2026-10-26T22:01:00Z" },
    { ...old, reported_at: "2026-10-26T21:25:00Z", received_at: "2026-10-26T21:54:00Z" }
  ] }, new Date(NOW));
  assert.equal(context.trail.report_count, 2);
  assert.equal(context.trail.observed_minutes, 10);
  assert.equal(buildLocationContext({ ...LOCATION, reported_at: "invalid" }, new Date(NOW)), null);
});

test("distance calculations handle identical positions and the date line", () => {
  assert.equal(coordinateDistanceMeters(LOCATION, LOCATION), 0);
  const acrossDateLine = coordinateDistanceMeters({ latitude: 0, longitude: 179.999 },
    { latitude: 0, longitude: -179.999 });
  assert.ok(acrossDateLine > 220 && acrossDateLine < 225);
});

test("Nearby Search normalization validates, bounds, deduplicates, and distance-sorts candidates", () => {
  const farther = { ...PLACES[0], id: "gym-1", displayName: { text: "Gym" },
    location: { latitude: 42.2805, longitude: -83.74 }, primaryType: "gym" };
  const candidates = normalizeNearbyPlaces({ places: [farther, PLACES[0], PLACES[0],
    { ...farther, id: "too-far", location: { latitude: 42.3, longitude: -83.74 } },
    { ...farther, id: "bad-point", location: { latitude: "42.28", longitude: -83.74 } },
    { ...farther, id: "nameless", displayName: {} }
  ] }, LOCATION);
  assert.deepEqual(candidates.map((place) => place.id), ["library-1", "gym-1"]);
  assert.equal(candidates[1].primary_type, "gym");
  assert.ok(candidates[0].distance_meters < candidates[1].distance_meters);
  assert.deepEqual(normalizeNearbyPlaces({}, LOCATION), []);
  assert.throws(() => normalizeNearbyPlaces({ places: null }, LOCATION));
});

test("location decisions require one complete submission with only known place references", () => {
  assert.deepEqual(parseLocationNudgeResponse(assessment(), PLACES), {
    send: true, reason: "suitable", message: DECISION.message,
    confidence: DECISION.confidence, explanation: DECISION.explanation
  });
  for (const response of [
    { ...assessment(), stop_reason: "max_tokens" },
    { ...assessment(), stop_reason: "pause_turn" },
    { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(DECISION) }] },
    assessment({ ...DECISION, send: "true" }),
    assessment({ ...DECISION, placeIds: ["invented-place"] }),
    assessment({ ...DECISION, send: true, reason: "moving" }),
    assessment({ ...DECISION, message: "" }),
    assessment({ ...DECISION, explanation: undefined }),
    assessment({ ...DECISION, explanation: "  " }),
    assessment({ ...DECISION, explanation: "x".repeat(301) }),
    { stop_reason: "tool_use", content: [...assessment().content, ...assessment().content] }
  ]) assert.throws(() => parseLocationNudgeResponse(response, PLACES));
  // The user chose Claude's judgment over a hard confidence cutoff.
  assert.equal(parseLocationNudgeResponse(assessment({ ...DECISION, confidence: "low" }), PLACES).send, true);
  assert.equal(parseLocationNudgeResponse(assessment({ ...DECISION, send: false,
    reason: "uncertain", message: "" }), PLACES).send, false);
});

test("nudge gates prevent every location read and Claude call when ineligible", async (t) => {
  for (const [name, options, now] of [
    ["outside window", {}, "2026-10-26T15:00:00Z"],
    ["daily cap", { nudges: Array(3).fill({ created_at: "2026-10-26T18:00:00Z" }) }],
    ["cooldown", { nudges: [{ created_at: "2026-10-26T21:00:00Z" }] }],
    ["calendar busy", { events: [{ start: { dateTime: "2026-10-26T21:30:00Z" },
      end: { dateTime: "2026-10-26T22:30:00Z" } }] }],
    ["short gap", { events: [{ start: { dateTime: "2026-10-26T22:20:00Z" },
      end: { dateTime: "2026-10-26T22:40:00Z" } }] }],
    ["no fitting tasks", { tasks: [{ ...TASK, duration: 400 }] }]
  ]) await t.test(name, async (t) => {
    const calls = fixture(t, options);
    await runNudgeTick(new Date(now || NOW));
    assert.equal(count(calls, "/rest/v1/owner_location"), 0);
    assert.equal(count(calls, "/v1/places:searchNearby"), 0);
    assert.equal(count(calls, "/v1/messages"), 0);
    assert.equal(count(calls, "/bottest/sendMessage"), 0);
    assert.equal(calls.decisionLogs.length, 1);
    assert.equal(calls.decisionLogs[0].event, "skipped");
    assert.equal(typeof calls.decisionLogs[0].reason, "string");
  });
});

test("missing or stale phone reports cause no Claude or Telegram calls", async (t) => {
  for (const location of [null, { ...LOCATION, reported_at: "2026-10-26T21:00:00Z" }]) {
    await t.test(String(location?.reported_at), async (t) => {
      const calls = fixture(t, { location });
      await runNudgeTick();
      assert.equal(count(calls, "/rest/v1/owner_location"), 1);
      assert.equal(count(calls, "/v1/places:searchNearby"), 0);
      assert.equal(count(calls, "/v1/messages"), 0);
      assert.equal(count(calls, "/bottest/sendMessage"), 0);
      assert.equal(calls.decisionLogs[0].reason, "location_unavailable_or_stale");
    });
  }
});

test("gym rejection skips Telegram, send-log, and history writes", async (t) => {
  const calls = fixture(t, { response: assessment({ ...DECISION, send: false,
    reason: "unsuitable_place", message: "",
    explanation: "The apparent setting may make a work suggestion disruptive." }) });
  await runNudgeTick();
  assert.equal(count(calls, "/v1/messages"), 1);
  assert.equal(count(calls, "/bottest/sendMessage"), 0);
  assert.equal(count(calls, "/rest/v1/nudges", "POST"), 0);
  assert.equal(count(calls, "/rest/v1/chat_messages"), 0);
  assert.deepEqual(calls.decisionLogs.map(({ event, send, reason, confidence, explanation }) =>
    ({ event, send, reason, confidence, explanation })), [{
    event: "assessment", send: false, reason: "unsuitable_place", confidence: "high",
    explanation: "The apparent setting may make a work suggestion disruptive."
  }]);
});

test("Claude still weighs recent travel instead of a hard movement/dwell gate", async (t) => {
  const calls = fixture(t, { location: { ...LOCATION, trail: [
    { ...LOCATION, latitude: 42.29, reported_at: "2026-10-26T21:45:00Z", received_at: "2026-10-26T21:45:01Z" }
  ] }, response: assessment({ ...DECISION, confidence: "low" }) });
  await runNudgeTick();
  const context = JSON.parse(calls.find((call) => call.path === "/v1/messages").body.messages[0].content);
  assert.ok(context.trail.maximum_separation_meters > 1100);
  assert.equal(count(calls, "/bottest/sendMessage"), 1);
});

test("an empty successful place search remains evidence for Claude to weigh", async (t) => {
  const calls = fixture(t, { mapsData: {}, response: assessment({ ...DECISION, placeIds: [] }) });
  await runNudgeTick();
  const context = JSON.parse(calls.find((call) => call.path === "/v1/messages").body.messages[0].content);
  assert.deepEqual(context.nearby_places, []);
  assert.equal(count(calls, "/bottest/sendMessage"), 1);
});

test("a failed place lookup skips Claude and Telegram instead of guessing or searching the web", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (message) => logs.push(message));
  const calls = fixture(t, { mapsError: true });
  await runNudgeTick();
  assert.equal(count(calls, "/v1/messages"), 0);
  assert.equal(count(calls, "/bottest/sendMessage"), 0);
  assert.deepEqual(logs, ["Nudge location assessment failed (HTTP 403); skipping this tick."]);
  assert.equal(calls.decisionLogs[0].reason, "location_assessment_failed");
  assert.equal(calls.decisionLogs[0].http_status, 403);
});

test("approved location uses one Claude request, then sends and records exact user-visible text", async (t) => {
  const calls = fixture(t);
  await runNudgeTick();
  assert.equal(count(calls, "/v1/messages"), 1);
  const body = calls.find((call) => call.path === "/v1/messages").body;
  assert.equal(body.tools[0].name, "submit_nudge_decision");
  assert.equal(body.tool_choice.type, "tool");
  assert.equal(body.tools.length, 1); // no web search fallback or second model request
  assert.equal(JSON.parse(body.messages[0].content).location.latitude, LOCATION.latitude);
  assert.equal(JSON.parse(body.messages[0].content).trail.report_count, 1);
  const maps = calls.find((call) => call.path === "/v1/places:searchNearby");
  assert.equal(count(calls, "/v1/places:searchNearby"), 1);
  assert.equal(maps.body.rankPreference, "DISTANCE");
  assert.equal(maps.body.locationRestriction.circle.radius, 150);
  assert.equal(maps.headers["X-Goog-Api-Key"], "test-maps-key");
  assert.equal(maps.headers["X-Goog-FieldMask"], "places.id,places.displayName,places.location,places.primaryType,places.types");
  assert.equal(count(calls, "/bottest/sendMessage"), 1);
  assert.equal(calls.find((call) => call.path === "/bottest/sendMessage").body.text, DECISION.message);
  assert.equal(count(calls, "/rest/v1/nudges", "POST"), 1);
  assert.equal(calls.find((call) => call.path === "/rest/v1/chat_messages").body.content, DECISION.message);
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  assert.deepEqual(calls.decisionLogs.map((entry) => entry.event), ["assessment", "sent"]);
  const logged = calls.decisionLogs[0];
  assert.equal(logged.explanation, DECISION.explanation);
  assert.equal(logged.confidence, "high");
  assert.equal(logged.send, true);
  assert.equal(logged.at, new Date(NOW).toISOString());
  assert.equal(logged.time_zone, "America/Los_Angeles");
  assert.equal(logged.tick_id, calls.decisionLogs[1].tick_id);
  assert.equal(logged.task_count, 1);
  assert.equal(logged.report_count, 1);
  assert.equal(logged.nearby_place_count, 1);
  for (const privateValue of [String(LOCATION.latitude), String(LOCATION.longitude),
    PLACES[0].id, PLACES[0].displayName.text, TASK.title, DECISION.message, "test-maps-key"]) {
    assert.ok(!JSON.stringify(calls.decisionLogs).includes(privateValue));
  }
});

test("assessment failures never fall back to an ungated suggestion", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fixture(t, { anthropicError: true });
  await runNudgeTick();
  assert.equal(count(calls, "/v1/messages"), 1);
  assert.equal(count(calls, "/bottest/sendMessage"), 0);
  assert.equal(calls.decisionLogs[0].reason, "location_assessment_failed");
  assert.ok(!JSON.stringify(calls.decisionLogs).includes("Do not expose request details"));
});

test("eligibility is checked again if time passes during the search", async (t) => {
  const calls = fixture(t, { onAssessment: () => t.mock.timers.tick(21 * 60 * 1000) });
  await runNudgeTick();
  assert.equal(count(calls, "/v1/messages"), 1);
  assert.equal(count(calls, "/bottest/sendMessage"), 0);
  assert.deepEqual(calls.decisionLogs.map((entry) => entry.event), ["assessment", "skipped"]);
  assert.equal(calls.decisionLogs[1].reason, "eligibility_changed_after_assessment");
});

test("a model approval is distinguished from failed Telegram delivery", async (t) => {
  const calls = fixture(t, { telegramError: true });
  await runNudgeTick();
  assert.deepEqual(calls.decisionLogs.map((entry) => entry.event), ["assessment", "delivery_failed"]);
  assert.equal(calls.decisionLogs[1].reason, "telegram_send_failed");
  assert.equal(count(calls, "/rest/v1/nudges", "POST"), 0);
  assert.ok(!JSON.stringify(calls.decisionLogs).includes("private telegram request details"));
});

test("malformed decisions are never included in logs", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fixture(t, { response: assessment({ ...DECISION, explanation: "private-raw-content",
    placeIds: ["invented-place"] }) });
  await runNudgeTick();
  assert.equal(calls.decisionLogs[0].reason, "location_assessment_failed");
  assert.ok(!JSON.stringify(calls.decisionLogs).includes("private-raw-content"));
  assert.equal(count(calls, "/bottest/sendMessage"), 0);
});

test("disabled location mode preserves the ordinary nudge copy and fallback", async (t) => {
  process.env.LOCATION_AWARE_NUDGES = "false";
  delete require.cache[require.resolve("../server.js")];
  const legacyTick = require("../server.js").runNudgeTick;
  const calls = fixture(t, { response: { content: [] } }); // force existing copy fallback
  await legacyTick();
  assert.equal(count(calls, "/rest/v1/owner_location"), 0);
  assert.equal(count(calls, "/v1/places:searchNearby"), 0);
  assert.equal(calls.find((call) => call.path === "/v1/messages").body.tools, undefined);
  assert.equal(count(calls, "/bottest/sendMessage"), 1);
  assert.deepEqual(calls.decisionLogs, []);
});
