"use strict";

/**
 * Personal Telegram task assistant. See AGENTS.md for product rules and deployment.
 *
 * Every required environment variable is validated in buildConfig() at boot, so a missing
 * credential fails the process immediately instead of at the next scheduled job.
 * Optional: CLAUDE_MODEL, DEBUG.
 */

require("dotenv").config();

const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_MAX_MESSAGE_LEN = 4096;
const AMERICA_LOS_ANGELES_TZ = "America/Los_Angeles";
/** Minutes of free time until the next busy block (or horizon) required before sending a reminder. */
const MIN_FREE_GAP_MINUTES_FOR_REMINDER = 30;
/** How far ahead to look for busy blocks. Every gate compares against <= 30 minutes. */
const CALENDAR_HORIZON_HOURS = 6;

/** Per-destination request timeouts. The long poll needs headroom over its own timeout=50. */
const TIMEOUT_MS = {
  anthropic: 20000,
  google: 10000,
  telegram: 10000,
  telegramPoll: 55000
};

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name} in environment.`);
  return value;
}

/**
 * Reads and validates every required variable once, at boot. Without this a missing
 * Google credential would not surface until the first midday reminder tick.
 */
function buildConfig() {
  const calendarIds = requireEnv("GOOGLE_CALENDAR_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!calendarIds.length) throw new Error("GOOGLE_CALENDAR_IDS was empty.");

  const chatIdRaw = requireEnv("TELEGRAM_CHAT_ID");
  const chatIdNum = Number(chatIdRaw);

  return Object.freeze({
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    claudeModel: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabaseKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    reminderChatId: Number.isFinite(chatIdNum) ? chatIdNum : chatIdRaw,
    google: Object.freeze({
      clientId: requireEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refreshToken: requireEnv("GOOGLE_REFRESH_TOKEN"),
      calendarIds: Object.freeze(calendarIds)
    }),
    debug: String(process.env.DEBUG || "").toLowerCase() === "true"
  });
}

const config = buildConfig();

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

/** Every outbound request goes through here so nothing can hang the single-threaded loop. */
function fetchWithTimeout(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function buildDebugPayload(payload) {
  return config.debug ? payload : undefined;
}

function taskError(errorMessage, debugDetails) {
  const err = new Error(errorMessage);
  err.body = { error: errorMessage, debug: buildDebugPayload(debugDetails) };
  return err;
}

const zonedPartsFormatters = new Map();

/** Constructing a DateTimeFormat is the expensive half of Intl; formatting with one is cheap. */
function getZonedPartsFormatter(timeZone) {
  const cached = zonedPartsFormatters.get(timeZone);
  if (cached) return cached;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  zonedPartsFormatters.set(timeZone, dtf);
  return dtf;
}

function getZonedParts(date, timeZone) {
  const parts = getZonedPartsFormatter(timeZone).formatToParts(date);
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second)
  };
}

function makeDateInTimeZone(local, timeZone) {
  // Convert a local wall-clock time in `timeZone` into a UTC Date.
  // We iteratively adjust from a UTC guess until formatted parts match.
  const desired = {
    year: Number(local.year),
    month: Number(local.month),
    day: Number(local.day),
    hour: Number(local.hour || 0),
    minute: Number(local.minute || 0),
    second: Number(local.second || 0)
  };
  let guess = new Date(
    Date.UTC(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
      desired.second,
      0
    )
  );

  for (let i = 0; i < 4; i++) {
    const got = getZonedParts(guess, timeZone);
    const deltaMinutes =
      (desired.year - got.year) * 525600 +
      (desired.month - got.month) * 43200 +
      (desired.day - got.day) * 1440 +
      (desired.hour - got.hour) * 60 +
      (desired.minute - got.minute);
    const deltaSeconds = desired.second - got.second;
    const deltaMs = deltaMinutes * 60000 + deltaSeconds * 1000;
    if (deltaMs === 0) break;
    guess = new Date(guess.getTime() + deltaMs);
  }
  return guess;
}

function isWithinEtSendWindow(now = new Date()) {
  const p = getZonedParts(now, AMERICA_LOS_ANGELES_TZ);
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 12 * 60 && minutes <= 22 * 60;
}

function getReminderDayStartEtUtc(now = new Date()) {
  const p = getZonedParts(now, AMERICA_LOS_ANGELES_TZ);
  const anchor = new Date(now.getTime());
  if (p.hour < 5) {
    // Move to previous day in PT by subtracting 12h (safe) and re-read parts.
    anchor.setTime(anchor.getTime() - 12 * 60 * 60000);
  }
  const a = getZonedParts(anchor, AMERICA_LOS_ANGELES_TZ);
  return makeDateInTimeZone(
    { year: a.year, month: a.month, day: a.day, hour: 5, minute: 0, second: 0 },
    AMERICA_LOS_ANGELES_TZ
  );
}

async function fetchGoogleAccessToken() {
  const { clientId, clientSecret, refreshToken } = config.google;
  const response = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token"
      }).toString()
    },
    TIMEOUT_MS.google
  );
  const json = await response.json().catch(() => ({}));
  if (!response.ok || typeof json?.access_token !== "string") {
    throw new Error(
      `Google token refresh failed: ${response.status} ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
}

let cachedGoogleToken = null;

/** Access tokens last about an hour; refreshing on every tick was a wasted round trip. */
async function getGoogleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now()) {
    return cachedGoogleToken.accessToken;
  }
  const { accessToken, expiresIn } = await fetchGoogleAccessToken();
  cachedGoogleToken = {
    accessToken,
    expiresAt: Date.now() + Math.max(0, expiresIn - 300) * 1000
  };
  return accessToken;
}

function parseGoogleEventBusyInterval(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (ev.status === "cancelled") return null;

  const start = ev.start;
  const end = ev.end;
  if (!start || !end) return null;

  // Ignore all-day events (date-only).
  if (typeof start.date === "string" || typeof end.date === "string") return null;

  const startDt = typeof start.dateTime === "string" ? new Date(start.dateTime) : null;
  const endDt = typeof end.dateTime === "string" ? new Date(end.dateTime) : null;
  if (!startDt || !endDt || !Number.isFinite(startDt.getTime()) || !Number.isFinite(endDt.getTime())) {
    return null;
  }
  if (endDt <= startDt) return null;

  // Ignore declined events (self attendee declined).
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const selfAttendee = attendees.find((a) => a && typeof a === "object" && a.self);
  if (selfAttendee && String(selfAttendee.responseStatus || "") === "declined") return null;

  return { start: startDt, end: endDt };
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((i) => i && i.start instanceof Date && i.end instanceof Date)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (!last || it.start > last.end) {
      out.push({ start: it.start, end: it.end });
    } else if (it.end > last.end) {
      last.end = it.end;
    }
  }
  return out;
}

/** Only the fields parseGoogleEventBusyInterval actually reads. */
const CALENDAR_FIELDS_MASK = "nextPageToken,items(status,start,end,attendees(self,responseStatus))";

async function fetchCalendarIntervals({ calendarId, accessToken, timeMin, timeMax }) {
  const intervals = [];
  let pageToken;

  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields", CALENDAR_FIELDS_MASK);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetchWithTimeout(
      url.toString(),
      { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
      TIMEOUT_MS.google
    );
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // A token can be revoked before it expires; drop it so the next tick refreshes.
      if (resp.status === 401) cachedGoogleToken = null;
      throw new Error(
        `Google Calendar events fetch failed for ${calendarId}: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`
      );
    }

    const items = Array.isArray(json?.items) ? json.items : [];
    for (const ev of items) {
      const interval = parseGoogleEventBusyInterval(ev);
      if (interval) intervals.push(interval);
    }

    pageToken = typeof json?.nextPageToken === "string" ? json.nextPageToken : undefined;
  } while (pageToken);

  return intervals;
}

async function fetchCalendarBusyIntervals({ timeMin, timeMax }) {
  const accessToken = await getGoogleAccessToken();
  const perCalendar = await Promise.all(
    config.google.calendarIds.map((calendarId) =>
      fetchCalendarIntervals({ calendarId, accessToken, timeMin, timeMax })
    )
  );
  return mergeIntervals(perCalendar.flat());
}

function computeCurrentFreeGap({ now, busyIntervals, horizonEnd }) {
  const t = now.getTime();
  for (const it of busyIntervals) {
    const s = it.start.getTime();
    const e = it.end.getTime();
    if (t >= s && t < e) {
      return {
        freeNow: false,
        remainingMinutes: 0,
        gapEnd: null,
        blockingEventEnd: it.end
      };
    }
  }

  let nextBusyStart = null;
  for (const it of busyIntervals) {
    if (it.start > now) {
      if (!nextBusyStart || it.start < nextBusyStart) nextBusyStart = it.start;
    }
  }

  const gapEnd = nextBusyStart && nextBusyStart < horizonEnd ? nextBusyStart : horizonEnd;
  const remainingMinutes = Math.max(0, Math.floor((gapEnd.getTime() - t) / 60000));
  return { freeNow: true, remainingMinutes, gapEnd, blockingEventEnd: null };
}

function isUuid(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    trimmed
  );
}

function extractJsonPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Claude response was empty.");

  // Expect JSON-only per prompt contract. Keep a small fallback for fenced JSON.
  try {
    return JSON.parse(raw);
  } catch (error) {
    const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    throw error;
  }
}

function normalizeOperationListPayload(raw) {
  const operations = Array.isArray(raw?.operations) ? raw.operations : null;
  if (!operations) {
    throw new Error("Claude response JSON did not include an operations array.");
  }
  return operations.map((op) => normalizeOperationPayload(op || {}));
}

function countAppliedByType(results, operation) {
  return results.filter((r) => r?.requested?.operation === operation && r.applied).length;
}

function buildFallbackMessageFromResults(results) {
  const created = countAppliedByType(results, "create");
  const updated = countAppliedByType(results, "update");
  const canceled = countAppliedByType(results, "delete");
  const completed = countAppliedByType(results, "complete");
  const pushed = countAppliedByType(results, "push");
  const failed = results.filter((r) => !r?.applied).length;

  const parts = [];
  if (created) parts.push(`Added ${created} ${created === 1 ? "task" : "tasks"}`);
  if (updated) parts.push(`Updated ${updated} ${updated === 1 ? "task" : "tasks"}`);
  if (canceled) parts.push(`canceled ${canceled} ${canceled === 1 ? "task" : "tasks"}`);
  if (completed) parts.push(`Completed ${completed} ${completed === 1 ? "task" : "tasks"}`);
  if (pushed) parts.push(`Pushed ${pushed} ${pushed === 1 ? "task" : "tasks"} to tomorrow`);
  if (!parts.length) parts.push("No changes were applied");
  if (failed) parts.push(`${failed} failed`);
  return parts.join("; ") + ".";
}

function normalizeMessage(rawMessage) {
  if (typeof rawMessage !== "string") return "";
  const trimmed = rawMessage.trim();
  return trimmed;
}

function normalizeTaskTitle(raw) {
  const title = typeof raw === "string" ? raw.trim() : "";
  return title || "Untitled Task";
}

function normalizeUrgency(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function normalizeDuration(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.round(value));
}

function parseOptionalUrgency(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function parseOptionalDuration(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(1, Math.round(value));
}

function normalizeOperationPayload(raw) {
  const operationRaw = String(raw?.operation || "")
    .trim()
    .toLowerCase();
  const allowed = new Set(["create", "update", "delete", "complete", "push"]);
  const operation = allowed.has(operationRaw) ? operationRaw : "create";
  const targetId = typeof raw?.targetId === "string" ? raw.targetId.trim() : "";

  if (operation === "create") {
    return {
      operation,
      targetId: null,
      fields: {
        title: normalizeTaskTitle(raw?.title),
        urgency: normalizeUrgency(raw?.urgency),
        duration: normalizeDuration(raw?.duration)
      }
    };
  }

  return {
    operation,
    targetId,
    fields: {
      title: typeof raw?.title === "string" ? raw.title.trim() : "",
      urgency: parseOptionalUrgency(raw?.urgency),
      duration: parseOptionalDuration(raw?.duration)
    }
  };
}

/** Columns every task consumer needs. Ordering by created_at does not require selecting it. */
const TASK_COLUMNS = "id,title,urgency,duration";

async function listTasksByStatus(status) {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Supabase list tasks failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
}

async function listOpenTasks() {
  return listTasksByStatus("open");
}

/** One round trip for several statuses at once, grouped in memory. */
async function listTasksGroupedByStatus(statuses) {
  const { data, error } = await supabase
    .from("tasks")
    .select(`${TASK_COLUMNS},status`)
    .in("status", statuses)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Supabase list tasks failed: ${error.message}`);
  }

  const grouped = Object.fromEntries(statuses.map((status) => [status, []]));
  for (const row of Array.isArray(data) ? data : []) {
    grouped[row?.status]?.push(row);
  }
  return grouped;
}

/**
 * One query answers both reminder gates. Looking only at today is safe for the cooldown:
 * the send window opens at 12:00 PT, so any reminder from a previous day is already
 * hours past the 120-minute cooldown.
 */
async function listRemindersSince(iso) {
  const { data, error } = await supabase
    .from("reminders")
    .select("created_at")
    .gte("created_at", iso)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Supabase list reminders failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function insertReminder(taskIds) {
  const { error } = await supabase
    .from("reminders")
    .insert({ task_ids: Array.isArray(taskIds) ? taskIds : [] });
  if (error) throw new Error(`Supabase insert reminder failed: ${error.message}`);
}

async function clearAllReminders() {
  // Filter is required by PostgREST but must not assume whether id is numeric or a uuid.
  const { error } = await supabase.from("reminders").delete().not("id", "is", null);
  if (error) throw new Error(`Supabase clear reminders failed: ${error.message}`);
}

async function canSendReminderNow(now = new Date()) {
  if (!isWithinEtSendWindow(now)) return { ok: false, reason: "outside_send_window" };

  const dayStart = getReminderDayStartEtUtc(now);
  const dayStartIso = dayStart.toISOString();
  const sentToday = await listRemindersSince(dayStartIso);
  if (sentToday.length >= 3) return { ok: false, reason: "daily_cap" };

  const lastCreatedAt = sentToday[0]?.created_at;
  if (lastCreatedAt) {
    const lastTs = new Date(lastCreatedAt);
    if (Number.isFinite(lastTs.getTime())) {
      const minsSince = (now.getTime() - lastTs.getTime()) / 60000;
      if (minsSince < 120) return { ok: false, reason: "cooldown" };
    }
  }

  return { ok: true, reason: "ok", dayStartIso, sentToday: sentToday.length };
}

async function clearAllOpenTasks() {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("status", "open");

  if (error) {
    throw new Error(error.message);
  }
}

/** Terminal status each non-create, non-update operation moves an open task to. */
const STATUS_BY_OPERATION = {
  delete: "canceled",
  complete: "completed",
  push: "pushed"
};

const NOT_OPEN_ERROR = "Task not found or no longer open.";

/**
 * Applies Claude's operations in as few round trips as possible: one insert for all
 * creates, one update per destination status, and one update per distinct field payload.
 * Updates run before status transitions so "rename X and mark it done" applies both.
 */
async function applyTaskOperations(operations) {
  const results = [];
  const creates = [];
  const updates = [];
  const byStatus = new Map();

  for (const op of operations) {
    if (op.operation === "create") {
      creates.push(op);
      continue;
    }

    if (!isUuid(op.targetId)) {
      results.push({
        requested: op,
        applied: false,
        error: "Missing or invalid targetId for this operation."
      });
      continue;
    }

    if (op.operation === "update") {
      updates.push(op);
      continue;
    }

    const status = STATUS_BY_OPERATION[op.operation];
    if (!status) continue;
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(op);
    else byStatus.set(status, [op]);
  }

  const nowIso = new Date().toISOString();

  if (creates.length) {
    const { error } = await supabase.from("tasks").insert(
      creates.map((op) => ({
        title: op.fields.title,
        urgency: op.fields.urgency,
        duration: op.fields.duration,
        status: "open"
      }))
    );
    for (const op of creates) {
      results.push({ requested: op, applied: !error, error: error?.message });
    }
  }

  for (const op of updates) {
    const updatePayload = {};
    if (op.fields.title) updatePayload.title = op.fields.title;
    if (op.fields.urgency !== undefined) updatePayload.urgency = op.fields.urgency;
    if (op.fields.duration !== undefined) updatePayload.duration = op.fields.duration;

    if (!Object.keys(updatePayload).length) {
      results.push({ requested: op, applied: false, error: "No fields provided to update." });
      continue;
    }

    updatePayload.updated_at = nowIso;

    const { data, error } = await supabase
      .from("tasks")
      .update(updatePayload)
      .eq("id", op.targetId)
      .eq("status", "open")
      .select("id");

    if (error) {
      results.push({ requested: op, applied: false, error: error.message });
      continue;
    }

    const applied = Array.isArray(data) && data.length > 0;
    results.push({ requested: op, applied, error: applied ? undefined : NOT_OPEN_ERROR });
  }

  for (const [status, ops] of byStatus) {
    const ids = [...new Set(ops.map((op) => op.targetId))];
    const { data, error } = await supabase
      .from("tasks")
      .update({ status, updated_at: nowIso })
      .in("id", ids)
      .eq("status", "open")
      .select("id");

    if (error) {
      for (const op of ops) results.push({ requested: op, applied: false, error: error.message });
      continue;
    }

    // Rows the filter did not match were already closed or never existed.
    const appliedIds = new Set((Array.isArray(data) ? data : []).map((row) => row?.id));
    for (const op of ops) {
      const applied = appliedIds.has(op.targetId);
      results.push({ requested: op, applied, error: applied ? undefined : NOT_OPEN_ERROR });
    }
  }

  return results;
}

async function processTaskQuery(query) {
  const currentTasks = await listOpenTasks();
  const prompt = [
    "You are a task operation parser named Tod.",
    "Given the user request and current task list, return JSON only with the shape:",
    '{ "operations": [ { operation, targetId, title, urgency, duration }, ... ], "message": "..." }',
    'operation must be one of: "create" | "update" | "delete" | "complete" | "push".',
    "Return one operation per requested change. Multiple operations are allowed in one response.",
    'Use "create" for new tasks, "update" to change title/urgency/duration, "delete" when the user abandons a task (not doing it — maps to cancelled),',
    '"complete" when the user finished a task, "push" when the user defers a task to the next day (maps to pushed; the server reopens pushed tasks as open every day at 5am Pacific).',
    "Current tasks lists only tasks with status open. Every targetId for update/delete/complete/push must be one of those ids.",
    "For update/delete/complete/push, set targetId to the id of the existing task.",
    "For create, targetId should be null or omitted.",
    "Urgency must be 1-10, duration in minutes.",
    "For update, title/urgency/duration are optional; omit or set null to keep the current value.",
    "For delete, complete, and push, title/urgency/duration are ignored.",
    "",
    'Also include a user-facing "message" string that summarizes what you did in friendly natural language.',
    'Do not mention JSON, operations arrays, fields, or any implementation details in "message".',
    'In "message", never include urgency, duration, task ids, or any numeric or internal metadata.',
    'Write "message" in natural conversational prose: use each task’s meaning, weave it into full sentences the way you would in speech, and paraphrase freely; do not recite or quote the stored task titles verbatim.',
    'If the "message" includes two or more distinct tasks (for example, answering "what do I need to do today?" or listing what remains), you MUST format the task portion as a bulleted list using "- " bullets, with one task per bullet on its own line (include newline characters in the string).',
    'For multi-task messages: write a short intro sentence, then the "- " bulleted list, and optionally a short closing phrase. Keep bullets friendly and meaning-based; do not dump or quote stored titles verbatim.',
    'If the "message" includes zero or one task, keep it as normal prose (no bullet list).',
    "",
    "Important: output JSON only. No prose. No markdown. No code fences.",
    "",
    `Current tasks: ${JSON.stringify(currentTasks)}`,
    `User request: ${query}`
  ].join("\n");

  let claudeResponse;
  try {
    claudeResponse = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: config.claudeModel,
          max_tokens: 800,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }]
        })
      },
      TIMEOUT_MS.anthropic
    );
  } catch (error) {
    throw taskError("I couldn’t update your tasks right now.", {
      type: "anthropic_fetch_failed",
      details:
        error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : "Unknown fetch error"
    });
  }

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text();
    throw taskError("I couldn’t update your tasks right now.", {
      type: "anthropic_api_error",
      status: claudeResponse.status,
      details: errorText.slice(0, 2000)
    });
  }

  const data = await claudeResponse.json();
  const textChunk = data?.content?.find((item) => item.type === "text")?.text;
  if (!textChunk) {
    throw taskError("I couldn’t understand the assistant response.", {
      type: "anthropic_missing_text"
    });
  }

  let parsed;
  try {
    parsed = extractJsonPayload(textChunk);
  } catch (error) {
    throw taskError("I couldn’t understand the assistant response.", {
      type: "anthropic_invalid_json",
      details:
        error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : "Unknown JSON parse error"
    });
  }

  let operations;
  try {
    operations = normalizeOperationListPayload(parsed);
  } catch (error) {
    throw taskError("I couldn’t understand the assistant response.", {
      type: "anthropic_missing_operations",
      details:
        error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : "Unknown operations parse error"
    });
  }

  const results = await applyTaskOperations(operations);
  return {
    message: normalizeMessage(parsed?.message) || buildFallbackMessageFromResults(results)
  };
}

function pickTopTasksThatFit({ tasks, remainingMinutes, maxTasks = 3 }) {
  const open = Array.isArray(tasks) ? tasks : [];
  const eligible = open.filter((t) => {
    const dur = Number(t?.duration);
    return Number.isFinite(dur) && dur > 0 && dur <= remainingMinutes;
  });
  eligible.sort((a, b) => Number(b?.urgency || 0) - Number(a?.urgency || 0));
  return eligible.slice(0, maxTasks);
}

function splitTelegramText(text) {
  const s = String(text || "");
  if (s.length <= TELEGRAM_MAX_MESSAGE_LEN) return [s];

  const chunks = [];
  let start = 0;
  while (start < s.length) {
    const end = Math.min(start + TELEGRAM_MAX_MESSAGE_LEN, s.length);
    let slice = s.slice(start, end);
    if (end < s.length) {
      const lastNl = slice.lastIndexOf("\n");
      if (lastNl > TELEGRAM_MAX_MESSAGE_LEN * 0.6) {
        slice = slice.slice(0, lastNl + 1);
      }
    }
    chunks.push(slice);
    start += slice.length;
  }
  return chunks;
}

async function telegramApi(method, body) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    TIMEOUT_MS.telegram
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const desc = data.description || response.statusText || "Telegram API error";
    throw new Error(desc);
  }
  return data;
}

async function telegramSendMessage(chatId, text) {
  const parts = splitTelegramText(text);
  for (const part of parts) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: part
    });
  }
}

async function generateReminderCopy({ remainingMinutes, gapEnd, tasks }) {
  const gapEndPt = gapEnd ? getZonedParts(gapEnd, AMERICA_LOS_ANGELES_TZ) : null;
  const gapEndStr = gapEndPt
    ? `${String(gapEndPt.hour).padStart(2, "0")}:${String(gapEndPt.minute).padStart(2, "0")} PT`
    : "";

  const prompt = [
    "You are a friendly personal productivity assistant.",
    "Write a short reminder suggesting what the user could do right now.",
    "",
    "Constraints:",
    "- Plain text only (no markdown).",
    "- Keep it to 1–3 sentences.",
    "- Suggestive tone (no guilt, no commands).",
    "- Do not include any task IDs or internal metadata.",
    "",
    `Context: The user is currently free for about ${remainingMinutes} minutes${
      gapEndStr ? ` (until around ${gapEndStr})` : ""
    }.`,
    "Here are up to 3 tasks that fit this window (choose how to phrase them; you may mention more than one):",
    JSON.stringify(
      (Array.isArray(tasks) ? tasks : []).map((t) => ({
        title: t.title,
        duration_minutes: t.duration,
        urgency: t.urgency
      }))
    )
  ].join("\n");

  const claudeResponse = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 200,
        temperature: 0.4,
        messages: [{ role: "user", content: prompt }]
      })
    },
    TIMEOUT_MS.anthropic
  );

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text().catch(() => "");
    throw new Error(`Anthropic reminder copy failed: ${claudeResponse.status} ${errorText.slice(0, 500)}`);
  }

  const data = await claudeResponse.json();
  const textChunk = data?.content?.find((item) => item.type === "text")?.text;
  const msg = typeof textChunk === "string" ? textChunk.trim() : "";
  if (!msg) throw new Error("Anthropic reminder copy was empty.");
  return msg;
}

async function generateMorningCopy({ tasks }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const titles = list
    .map((t) => (typeof t?.title === "string" ? t.title.trim() : ""))
    .filter(Boolean);

  const prompt = [
    "You are a personal productivity assistant.",
    "Write a good-morning message that helps the user start the day.",
    "",
    "Context: These are the tasks still open on the user's to-do list this morning.",
    "",
    "Constraints:",
    "- Plain text only (no markdown).",
    "- Human, warm, and friendly tone, but not verbose.",
    "- Do not mention any technical details, IDs, databases, urgency, duration, estimates, timestamps, or anything numeric.",
    "- Do not quote JSON or mention prompts or APIs.",
    "- If there are zero tasks, say the to-do list is empty in a positive way.",
    '- If there is exactly one task, write 1–2 sentences of normal prose and do NOT use bullets.',
    '- If there are two or more tasks, write a short intro sentence, then a bulleted list using "- " bullets with one task per bullet, then a VERY short motivating closing phrase (max three words).',
    "",
    "Open tasks (titles):",
    JSON.stringify(titles)
  ].join("\n");

  const claudeResponse = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.claudeModel,
        max_tokens: 220,
        temperature: 0.6,
        messages: [{ role: "user", content: prompt }]
      })
    },
    TIMEOUT_MS.anthropic
  );

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text().catch(() => "");
    throw new Error(`Anthropic morning copy failed: ${claudeResponse.status} ${errorText.slice(0, 500)}`);
  }

  const data = await claudeResponse.json();
  const textChunk = data?.content?.find((item) => item.type === "text")?.text;
  const msg = typeof textChunk === "string" ? textChunk.trim() : "";
  if (!msg) throw new Error("Anthropic morning copy was empty.");
  return msg;
}

function formatTaskListLine(task) {
  const id = typeof task?.id === "string" ? task.id : "";
  const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const title = typeof task?.title === "string" ? task.title : "Untitled";
  const u = task?.urgency;
  const d = task?.duration;
  return `• ${title} (u:${u} · ${d}m · ${shortId})`;
}

function buildNightlyDigestText({ open, completed, canceled }) {
  const formatTitleBullet = (task) => {
    const title = typeof task?.title === "string" ? task.title.trim() : "";
    return `- ${title || "Untitled task"}`;
  };

  const section = (title, tasks) => {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.length) return [`${title}`, "None.", ""].join("\n");
    return [`${title}`, ...list.map(formatTitleBullet), ""].join("\n");
  };

  const body = [
    "Nightly recap",
    "",
    section("Completed", completed),
    section("Canceled", canceled),
    section("Still to do", open),
    "Let me know if you want to mark anything as done, or push anything to tomorrow."
  ].join("\n");

  return body.trim();
}

async function runNightlyDigest() {
  let grouped;
  try {
    grouped = await listTasksGroupedByStatus(["open", "completed", "canceled"]);
  } catch (err) {
    console.error("Nightly digest: failed to load tasks:", err instanceof Error ? err.message : err);
    return;
  }

  const { open, completed, canceled } = grouped;

  const text = buildNightlyDigestText({ open, completed, canceled });
  try {
    await telegramSendMessage(config.reminderChatId, text);
  } catch (err) {
    console.error("Nightly digest: Telegram send failed:", err instanceof Error ? err.message : err);
  }
}

function buildMorningFallbackText(open) {
  const list = Array.isArray(open) ? open : [];
  const titles = list
    .map((t) => (typeof t?.title === "string" ? t.title.trim() : ""))
    .filter(Boolean);

  if (!titles.length) {
    return ["Good morning.", "", "Your to-do list is empty today."].join("\n");
  }

  if (titles.length === 1) {
    return `Good morning. Here’s what’s still on your list: ${titles[0]}.`;
  }

  return ["Good morning. Here’s what’s still on your list:", ...titles.map((t) => `- ${t}`)].join("\n");
}

async function runMorningMessage() {
  let open;
  try {
    open = await listOpenTasks();
  } catch (err) {
    console.error("Morning message: failed to load open tasks:", err instanceof Error ? err.message : err);
    return;
  }

  let text;
  try {
    text = await generateMorningCopy({ tasks: open });
  } catch (err) {
    console.error(
      "Morning message: Claude copy failed; using fallback:",
      err instanceof Error ? err.message : err
    );
    text = buildMorningFallbackText(open);
  }

  try {
    await telegramSendMessage(config.reminderChatId, text);
  } catch (err) {
    console.error("Morning message: Telegram send failed:", err instanceof Error ? err.message : err);
  }
}

function telegramHelpText() {
  return [
    "Task Thread (Telegram)",
    "",
    "Send any message to manage tasks in natural language (add, edit, mark done, cancel, or push to tomorrow).",
    "",
    "Commands:",
    "/list — open tasks",
    "/clear — cancel all open tasks",
    "/help — this text"
  ].join("\n");
}

async function dispatchTelegramMessage(chatId, textRaw) {
  const text = String(textRaw || "").trim();
  if (!text) return;

  const lower = text.toLowerCase();
  if (lower === "/start" || lower === "/help" || lower.startsWith("/help ")) {
    await telegramSendMessage(chatId, telegramHelpText());
    return;
  }

  if (lower === "/list" || lower.startsWith("/list ")) {
    const tasks = await listOpenTasks();
    if (!tasks.length) {
      await telegramSendMessage(chatId, "No open tasks.");
      return;
    }
    const body = ["Open tasks:", ...tasks.map(formatTaskListLine)].join("\n");
    await telegramSendMessage(chatId, body);
    return;
  }

  if (lower === "/clear" || lower.startsWith("/clear ")) {
    try {
      await clearAllOpenTasks();
      await telegramSendMessage(chatId, "All open tasks canceled.");
    } catch {
      await telegramSendMessage(chatId, "Couldn’t clear tasks. Try again later.");
    }
    return;
  }

  try {
    const payload = await processTaskQuery(text);
    await telegramSendMessage(chatId, payload.message || "Done.");
  } catch (error) {
    const msg =
      error && typeof error === "object" && "body" in error && error.body && typeof error.body.error === "string"
        ? error.body.error
        : error instanceof Error
          ? error.message
          : "I couldn’t update your tasks right now.";
    await telegramSendMessage(chatId, msg);
  }
}

async function handleTelegramUpdate(update) {
  const msg = update?.message;
  if (!msg || typeof msg.text !== "string") return;
  const chatId = msg.chat?.id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return;
  const id = typeof chatId === "string" ? Number(chatId) : chatId;
  await dispatchTelegramMessage(id, msg.text);
}

let pollingOffset = 0;
let pollingActive = false;
/** Tracked so SIGTERM can let the message being handled finish before exiting. */
let inFlightDispatch = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegramPollingLoop() {
  if (pollingActive) return;
  pollingActive = true;

  const url = new URL(`https://api.telegram.org/bot${config.telegramBotToken}/getUpdates`);
  url.searchParams.set("timeout", "50");
  url.searchParams.set("limit", "10");
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

  while (pollingActive) {
    try {
      url.searchParams.set("offset", String(pollingOffset));

      const response = await fetchWithTimeout(
        url.toString(),
        { method: "GET" },
        TIMEOUT_MS.telegramPoll
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok || !Array.isArray(data.result)) {
        await sleep(3000);
        continue;
      }

      for (const update of data.result) {
        if (!pollingActive) break;
        pollingOffset = update.update_id + 1;
        inFlightDispatch = handleTelegramUpdate(update);
        try {
          await inFlightDispatch;
        } finally {
          inFlightDispatch = null;
        }
      }
    } catch (err) {
      console.error("Telegram polling error:", err instanceof Error ? err.message : err);
      await sleep(3000);
    }
  }
}

function startTelegramPolling() {
  console.log("Telegram long polling started.");
  telegramPollingLoop();
}

async function runDailyRollover() {
  const now = new Date().toISOString();
  const { error: reopenError } = await supabase
    .from("tasks")
    .update({ status: "open", updated_at: now })
    .eq("status", "pushed");

  if (reopenError) {
    console.error("Daily rollover: failed to reopen pushed tasks:", reopenError.message);
  }

  const { error: deleteError } = await supabase
    .from("tasks")
    .delete()
    .in("status", ["completed", "canceled"]);

  if (deleteError) {
    console.error("Daily rollover: failed to delete closed tasks:", deleteError.message);
  }

  try {
    await clearAllReminders();
  } catch (err) {
    console.error(
      "Daily rollover: failed to clear reminders:",
      err instanceof Error ? err.message : err
    );
  }
}

async function runSmartReminderTick() {
  const now = new Date();
  const debug = (...args) => {
    if (config.debug) console.log("[smartreminder]", ...args);
  };

  let gates;
  try {
    gates = await canSendReminderNow(now);
  } catch (err) {
    debug("Gate check failed:", err instanceof Error ? err.message : err);
    return;
  }
  if (!gates.ok) {
    debug("Not eligible:", gates.reason);
    return;
  }

  const horizonEnd = new Date(now.getTime() + CALENDAR_HORIZON_HOURS * 60 * 60000);

  let busyIntervals;
  try {
    busyIntervals = await fetchCalendarBusyIntervals({ timeMin: now, timeMax: horizonEnd });
  } catch (err) {
    debug("Calendar fetch failed:", err instanceof Error ? err.message : err);
    return;
  }

  const gap = computeCurrentFreeGap({ now, busyIntervals, horizonEnd });
  if (!gap.freeNow) {
    debug("Busy until:", gap.blockingEventEnd?.toISOString());
    return;
  }
  if (!gap.remainingMinutes || gap.remainingMinutes <= 0) return;
  if (gap.remainingMinutes < MIN_FREE_GAP_MINUTES_FOR_REMINDER) {
    debug("Gap too short for reminder:", gap.remainingMinutes, "<", MIN_FREE_GAP_MINUTES_FOR_REMINDER);
    return;
  }

  let tasks;
  try {
    tasks = await listOpenTasks();
  } catch (err) {
    debug("List tasks failed:", err instanceof Error ? err.message : err);
    return;
  }

  const picked = pickTopTasksThatFit({ tasks, remainingMinutes: gap.remainingMinutes, maxTasks: 3 });
  if (!picked.length) {
    debug("No tasks fit remaining gap:", gap.remainingMinutes);
    return;
  }

  let message;
  try {
    message = await generateReminderCopy({
      remainingMinutes: gap.remainingMinutes,
      gapEnd: gap.gapEnd,
      tasks: picked
    });
  } catch (err) {
    debug("Claude reminder copy failed; using fallback:", err instanceof Error ? err.message : err);
    const titles = picked.map((t) => t?.title).filter(Boolean);
    const until = gap.gapEnd ? getZonedParts(gap.gapEnd, AMERICA_LOS_ANGELES_TZ) : null;
    const untilStr = until
      ? `${String(until.hour).padStart(2, "0")}:${String(until.minute).padStart(2, "0")} PT`
      : "";
    message = `You’ve got about ${gap.remainingMinutes} minutes free${
      untilStr ? ` (until around ${untilStr})` : ""
    }. If you’re up for it, you could work on ${titles.slice(0, 3).join(" / ")}.`;
  }

  try {
    await telegramSendMessage(config.reminderChatId, message);
  } catch (err) {
    debug("Telegram send failed:", err instanceof Error ? err.message : err);
    return;
  }

  try {
    await insertReminder(picked.map((t) => t.id).filter((id) => typeof id === "string"));
  } catch (err) {
    debug("Reminder persist failed:", err instanceof Error ? err.message : err);
  }
}

const inFlightJobs = new Set();

/**
 * Cron ticks are skipped, not queued, while the previous run is still going. Without this
 * a reminder tick that outlives its 10-minute interval could double-send.
 */
function runExclusive(name, fn) {
  return () => {
    if (inFlightJobs.has(name)) {
      console.warn(`${name}: previous run still in flight; skipping this tick.`);
      return;
    }
    inFlightJobs.add(name);
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`${name} error:`, err instanceof Error ? err.message : err))
      .finally(() => inFlightJobs.delete(name));
  };
}

const SCHEDULED_JOBS = [
  {
    name: "Daily rollover",
    expression: "0 5 * * *",
    run: runDailyRollover,
    note: "05:00 PT (pushed→open, delete completed + canceled, clear reminders)"
  },
  { name: "Morning message", expression: "30 5 * * *", run: runMorningMessage, note: "05:30 PT" },
  {
    name: "Smart reminder",
    expression: "*/10 * * * *",
    run: runSmartReminderTick,
    note: "every 10 minutes (12:00–22:00 PT, ≥30 min free gap, caps + cooldown enforced)"
  },
  { name: "Nightly digest", expression: "0 22 * * *", run: runNightlyDigest, note: "22:00 PT" }
];

function startScheduledJobs() {
  for (const job of SCHEDULED_JOBS) {
    cron.schedule(job.expression, runExclusive(job.name, job.run), {
      timezone: AMERICA_LOS_ANGELES_TZ
    });
    console.log(`Scheduled ${job.name}: ${job.note}.`);
  }
}

let shuttingDown = false;

/** Railway sends SIGTERM on redeploy; finish the message in hand so it is not replayed. */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; finishing in-flight work before exit.`);
  pollingActive = false;
  try {
    await inFlightDispatch;
  } catch {
    // Dispatch failures are already logged at the point they happen.
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startScheduledJobs();
startTelegramPolling();
