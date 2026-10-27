"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
for (const name of ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) process.env[name] = "test";
Object.assign(process.env, {
  TELEGRAM_CHAT_ID: "1", SUPABASE_URL: "https://example.supabase.co", GOOGLE_CALENDAR_IDS: "primary",
  LOCATION_AWARE_NUDGES: "true", GOOGLE_MAPS_API_KEY: "test", DEBUG: "false"
});
const { processUserQuery, runDailyRollover, runReminderTick } = require("../server.js");
const NOW = Date.parse("2026-11-01T08:31:00Z"); // 01:31 PDT, before the repeated hour

function mockServices(t, state, { modelReply, onSend } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const sends = [];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    calls.push({ url, method });
    if (url.hostname === "api.anthropic.com") {
      assert.ok(modelReply, "Unexpected model call");
      const body = JSON.parse(init.body);
      assert.match(body.messages.at(-1).content, /Current user request: What do I need to do\?/);
      assert.equal(body.tools.some((tool) => tool.name === "web_search"), false);
      return Response.json({ stop_reason: "tool_use", content: [{
        type: "tool_use", id: "submit-1", name: "submit_operations",
        input: { operations: [], message: modelReply }
      }] });
    }
    if (url.hostname === "api.telegram.org") {
      onSend?.();
      sends.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: {} });
    }
    const table = url.pathname.replace("/rest/v1/", "");
    assert.ok(Object.hasOwn(state, table), `Unexpected table or service: ${url.pathname}`);
    const matches = (row) => [...url.searchParams].every(([key, filter]) => {
      if (["select", "order", "limit", "offset"].includes(key)) return true;
      if (filter === "not.is.null") return row[key] != null;
      if (filter.startsWith("eq.")) return String(row[key]) === filter.slice(3);
      if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").map((v) => v.replaceAll('"', "")).includes(String(row[key]));
      if (filter.startsWith("lt.")) return row[key] < filter.slice(3);
      if (filter.startsWith("lte.")) return row[key] <= filter.slice(4);
      if (filter.startsWith("gte.")) return row[key] >= filter.slice(4);
      throw new Error(`Unhandled test filter: ${filter}`);
    });
    const selected = state[table].filter(matches);
    if (method === "GET") return Response.json(selected);
    if (method === "PATCH") {
      const payload = JSON.parse(init.body);
      for (const row of selected) Object.assign(row, payload);
      return Response.json(selected);
    }
    if (method === "DELETE") {
      state[table] = state[table].filter((row) => !selected.includes(row));
      return Response.json(null);
    }
    if (method === "POST") {
      const payload = JSON.parse(init.body);
      state[table].push(...(Array.isArray(payload) ? payload : [payload]));
      return Response.json(null);
    }
    throw new Error(`Unhandled test method: ${method}`);
  });
  return { sends, calls };
}

test("ordinary natural-language task listing does not read or transmit location", async (t) => {
  const state = {
    tasks: [{ id: "task-1", title: "Read a chapter", status: "open", urgency: 5, duration: 30 }],
    scheduled_reminders: [], chat_messages: []
  };
  const { calls } = mockServices(t, state, { modelReply: "You have a chapter to read." });
  assert.equal(await processUserQuery("What do I need to do?", "1"), "You have a chapter to read.");
  assert.ok(calls.every((call) => !call.url.pathname.includes("location") && call.method !== "PATCH"));
});

test("rollover reopens pushed tasks, clears closed tasks and nudges, and preserves pending reminders", async (t) => {
  const old = "2026-10-01T00:00:00Z";
  const state = {
    tasks: [{ id: "a", status: "open" }, { id: "b", status: "pushed" },
      { id: "c", status: "completed" }, { id: "d", status: "canceled" }],
    nudges: [{ id: "uuid-send-log" }],
    chat_messages: [{ created_at: old }, { created_at: "2026-11-01T08:30:00Z" }],
    scheduled_reminders: [{ id: "future", status: "pending", updated_at: old },
      { id: "expired", status: "sent", updated_at: old }]
  };
  mockServices(t, state);
  await runDailyRollover();
  assert.deepEqual(state.tasks.map(({ id, status }) => ({ id, status })), [{ id: "a", status: "open" }, { id: "b", status: "open" }]);
  assert.deepEqual(state.nudges, []);
  assert.equal(state.chat_messages.length, 1);
  assert.deepEqual(state.scheduled_reminders.map((row) => row.id), ["future"]);
});

test("timed reminders bypass location; one-off claims once and daily series keeps its DST wall clock", async (t) => {
  const base = { chat_id: "1", status: "pending", body: "call your dad", attempts: 0,
    occurrences_sent: 0, next_due_at: "2026-11-01T08:30:00Z", created_at: "2026-10-01T00:00:00Z",
    time_zone: "America/Los_Angeles" };
  const state = { scheduled_reminders: [
    { ...base, id: "once", recurrence: null },
    { ...base, id: "daily", recurrence: { freq: "daily", interval: 1, hour: 1, minute: 30 } }
  ], chat_messages: [] };
  const { sends, calls } = mockServices(t, state, { onSend: () => {
    if (state.scheduled_reminders[0].status === "sending") return;
    assert.equal(state.scheduled_reminders[1].next_due_at, "2026-11-02T09:30:00.000Z");
  } });
  await runReminderTick();
  await runReminderTick();
  assert.equal(sends.length, 2);
  assert.equal(state.scheduled_reminders[0].status, "sent");
  assert.equal(state.scheduled_reminders[0].occurrences_sent, 1);
  assert.equal(state.scheduled_reminders[1].next_due_at, "2026-11-02T09:30:00.000Z");
  assert.equal(state.chat_messages.length, 2);
  assert.ok(calls.every((call) => !call.url.pathname.includes("getUpdates") && !call.url.pathname.includes("location") && !call.url.hostname.includes("googleapis")));
});
