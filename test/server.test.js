"use strict";

// server.js validates its config at load. Placeholders let the pure logic be required
// without credentials; nothing here touches the network.
for (const name of [
  "TELEGRAM_BOT_TOKEN",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN"
]) {
  process.env[name] = "test";
}
process.env.TELEGRAM_CHAT_ID = "1";
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.GOOGLE_CALENDAR_IDS = "primary";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildConversationMessages,
  buildUserQueryMessage,
  computeCurrentFreeGap,
  computeNextOccurrence,
  describeRecurrence,
  errorMessage,
  formatZonedClock,
  normalizeHistoryToolInput,
  normalizeOperationPayload,
  normalizeRecurrence,
  normalizeTimeZone,
  parseDueLocal,
  parseGoogleEventBusyInterval,
  pickTopTasksThatFit,
  resolveOneOffDue,
  resolveZonedWallClock,
  splitTelegramText,
  UserFacingError
} = require("../server.js");

const LA = "America/Los_Angeles";
const iso = (date) => date.toISOString();

test("spring-forward wall clock resolves to the first instant that exists", () => {
  // 2026-03-08 02:30 does not exist in Los Angeles; the clock jumps 02:00 -> 03:00 PDT.
  const instant = resolveZonedWallClock({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA);
  assert.equal(iso(instant), "2026-03-08T10:00:00.000Z");
});

test("daily reminder keeps its wall clock across DST instead of drifting an hour", () => {
  const recurrence = normalizeRecurrence({ freq: "daily", hour: 8 });
  const after = new Date("2026-03-07T17:00:00Z"); // 9am PST, the day before spring forward
  const next = computeNextOccurrence(recurrence, { after, timeZone: LA, anchor: after });
  assert.equal(iso(next), "2026-03-08T15:00:00.000Z"); // 8am PDT
});

test("fall-back repeated hour fires a daily 01:30 reminder once", () => {
  const recurrence = normalizeRecurrence({ freq: "daily", hour: 1, minute: 30 });
  const anchor = new Date("2026-10-01T00:00:00Z");
  const first = computeNextOccurrence(recurrence, {
    after: new Date("2026-11-01T07:00:00Z"), // 00:00 PDT on the fall-back day
    timeZone: LA,
    anchor
  });
  const second = computeNextOccurrence(recurrence, { after: first, timeZone: LA, anchor });
  assert.ok(first < new Date("2026-11-01T10:00:00Z"));
  assert.equal(iso(second), "2026-11-02T09:30:00.000Z"); // next day, 01:30 PST
});

test("monthly on the 31st clamps to the end of a short month", () => {
  const recurrence = normalizeRecurrence({ freq: "monthly", byMonthDay: 31, hour: 9 });
  const after = new Date("2027-02-01T20:00:00Z");
  const next = computeNextOccurrence(recurrence, { after, timeZone: LA, anchor: after });
  assert.equal(iso(next), "2027-02-28T17:00:00.000Z");
});

test("every other Monday keeps its parity from the anchor", () => {
  const recurrence = normalizeRecurrence({ freq: "weekly", interval: 2, byWeekday: [1], hour: 9 });
  const anchor = new Date("2026-10-12T18:00:00Z"); // Monday 11am PDT
  const next = computeNextOccurrence(recurrence, {
    after: new Date("2026-10-13T18:00:00Z"),
    timeZone: LA,
    anchor
  });
  assert.equal(iso(next), "2026-10-26T16:00:00.000Z"); // skips 10-19
});

test("recurrence until stops the series", () => {
  const recurrence = normalizeRecurrence({ freq: "daily", hour: 9, until: "2026-10-14" });
  const after = new Date("2026-10-14T17:00:00Z"); // 10am, already past today's 9am
  assert.equal(computeNextOccurrence(recurrence, { after, timeZone: LA, anchor: after }), null);
});

test("normalizeRecurrence rejects instead of coercing", () => {
  assert.throws(() => normalizeRecurrence({ freq: "hourly", hour: 1 }), UserFacingError);
  assert.throws(() => normalizeRecurrence({ freq: "weekly", hour: 8 }), UserFacingError);
  assert.throws(() => normalizeRecurrence({ freq: "daily" }), UserFacingError);
  assert.throws(() => normalizeRecurrence({ freq: "daily", hour: 8, interval: 0 }), UserFacingError);
  assert.deepEqual(normalizeRecurrence({ freq: "weekly", hour: 8, byWeekday: [7, 1, 1] }), {
    freq: "weekly",
    interval: 1,
    hour: 8,
    minute: 0,
    byWeekday: [0, 1]
  });
  assert.equal(normalizeRecurrence(null), null);
});

test("describeRecurrence names common schedules", () => {
  const weekdays = normalizeRecurrence({ freq: "weekly", byWeekday: [1, 2, 3, 4, 5], hour: 8 });
  assert.equal(describeRecurrence(weekdays), "every weekday at 8:00 AM");
  const yearly = normalizeRecurrence({ freq: "yearly", month: 3, byMonthDay: 15, hour: 13, count: 3 });
  assert.equal(describeRecurrence(yearly), "every year on March 15 at 1:00 PM (3 times)");
});

test("parseDueLocal rejects impossible dates and times", () => {
  assert.equal(parseDueLocal("2026-02-30T09:00"), null);
  assert.equal(parseDueLocal("2026-10-14T24:00"), null);
  assert.equal(parseDueLocal("2026-10-14T09:00Z"), null);
  assert.deepEqual(parseDueLocal("2026-10-14 09:05"), {
    year: 2026,
    month: 10,
    day: 14,
    hour: 9,
    minute: 5
  });
});

test("one-off reminders: bare passed time rolls forward, past date is refused", () => {
  const now = new Date("2026-10-14T17:00:00Z"); // 10am PDT
  const rolled = resolveOneOffDue({ dueLocal: "2026-10-14T09:00" }, { now, timeZone: LA });
  assert.equal(iso(rolled), "2026-10-15T16:00:00.000Z");
  assert.throws(
    () => resolveOneOffDue({ dueLocal: "2026-10-12T09:00" }, { now, timeZone: LA }),
    UserFacingError
  );
  assert.throws(
    () => resolveOneOffDue({ dueLocal: "2032-10-14T09:00" }, { now, timeZone: LA }),
    /too far/
  );
  const relative = resolveOneOffDue({ inMinutes: 20 }, { now, timeZone: LA });
  assert.equal(iso(relative), "2026-10-14T17:20:00.000Z");
  assert.throws(() => resolveOneOffDue({ dueLocal: "" }, { now, timeZone: LA }), UserFacingError);
});

test("free gap only reports an end time when a real event ends it", () => {
  const now = new Date("2026-10-14T20:00:00Z");
  const horizonEnd = new Date("2026-10-15T02:00:00Z");

  const clear = computeCurrentFreeGap({ now, busyIntervals: [], horizonEnd });
  assert.equal(clear.gapEndsAtEvent, false);
  assert.equal(clear.remainingMinutes, 360);

  const meeting = {
    start: new Date("2026-10-14T20:45:00Z"),
    end: new Date("2026-10-14T21:30:00Z")
  };
  const beforeMeeting = computeCurrentFreeGap({ now, busyIntervals: [meeting], horizonEnd });
  assert.equal(beforeMeeting.gapEndsAtEvent, true);
  assert.equal(beforeMeeting.remainingMinutes, 45);

  const during = computeCurrentFreeGap({
    now: new Date("2026-10-14T21:00:00Z"),
    busyIntervals: [meeting],
    horizonEnd
  });
  assert.equal(during.freeNow, false);
});

test("calendar parser ignores all-day, cancelled, and declined events", () => {
  const timed = { start: { dateTime: "2026-10-14T10:00:00Z" }, end: { dateTime: "2026-10-14T11:00:00Z" } };
  assert.ok(parseGoogleEventBusyInterval(timed));
  assert.equal(parseGoogleEventBusyInterval({ start: { date: "2026-10-14" }, end: { date: "2026-10-15" } }), null);
  assert.equal(parseGoogleEventBusyInterval({ ...timed, status: "cancelled" }), null);
  assert.equal(
    parseGoogleEventBusyInterval({ ...timed, attendees: [{ self: true, responseStatus: "declined" }] }),
    null
  );
});

test("nudge picks the most urgent tasks that fit the gap", () => {
  const tasks = [
    { id: "a", title: "long", urgency: 10, duration: 90 },
    { id: "b", title: "low", urgency: 2, duration: 15 },
    { id: "c", title: "high", urgency: 8, duration: 30 }
  ];
  assert.deepEqual(
    pickTopTasksThatFit({ tasks, remainingMinutes: 45 }).map((t) => t.id),
    ["c", "b"]
  );
});

test("nudge clock reads like reminder times", () => {
  assert.equal(formatZonedClock(new Date("2026-10-14T21:30:00Z"), LA), "2:30 PM");
});

test("splitTelegramText keeps every character and respects the limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} `.repeat(3)).join("\n");
  const chunks = splitTelegramText(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4096));
  assert.equal(chunks.join(""), text);
  assert.deepEqual(splitTelegramText("short"), ["short"]);
});

test("conversation context starts with a user turn and orders ties user-first", () => {
  const rows = [
    { role: "assistant", content: "reply", created_at: "2026-10-14T10:00:01Z" },
    { role: "assistant", content: "nudge", created_at: "2026-10-14T09:00:00Z" },
    { role: "user", content: "hi", created_at: "2026-10-14T10:00:01Z" }
  ];
  assert.deepEqual(buildConversationMessages(rows), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "reply" }
  ]);
});

test("history search window is clamped to seven days and now", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const input = normalizeHistoryToolInput(
    { query: " dad ", since: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:00Z" },
    now
  );
  assert.deepEqual(input, {
    query: "dad",
    since: "2026-10-07T12:00:00.000Z",
    before: "2026-10-14T12:00:00.000Z"
  });
});

test("reply text uses Node's reminder confirmation, not Claude's prose", () => {
  const operations = [normalizeOperationPayload({ operation: "create_reminder", body: "call" })];
  const results = [{ requested: operations[0], applied: true, userMessage: "Okay, I’ll remind you." }];
  assert.equal(buildUserQueryMessage("Sure, 2pm!", operations, results), "Okay, I’ll remind you.");
});

test("task replies fall back to a deterministic summary when Claude omits message", () => {
  const operations = [normalizeOperationPayload({ operation: "create", title: "x" })];
  const results = [{ requested: operations[0], applied: true }];
  assert.equal(buildUserQueryMessage(undefined, operations, results), "Added 1 task.");
});

test("unknown operations are rejected, not turned into tasks", () => {
  assert.deepEqual(normalizeOperationPayload({ operation: "explode" }), {
    operation: "invalid",
    rawOperation: "explode"
  });
});

test("timezone aliases resolve to IANA names", () => {
  assert.equal(normalizeTimeZone("Eastern"), "America/New_York");
  assert.equal(normalizeTimeZone("America/Chicago"), "America/Chicago");
  assert.throws(() => normalizeTimeZone("Mars/Base"), UserFacingError);
});

test("errorMessage includes the cause chain for logs", () => {
  const err = new UserFacingError("outer", { cause: new Error("inner") });
  assert.equal(errorMessage(err), "outer (inner)");
  assert.equal(errorMessage("plain"), "plain");
});
