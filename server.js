"use strict";

/**
 * Env (see .gitignore for .env):
 * - ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required for tasks)
 * - CLAUDE_MODEL, DEBUG
 * - TELEGRAM_BOT_TOKEN: required; server long-polls Telegram getUpdates for this bot.
 */

require("dotenv").config();

const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const TELEGRAM_MAX_MESSAGE_LEN = 4096;
const AMERICA_NEW_YORK_TZ = "America/New_York";
/** Minutes of free time until the next busy block (or horizon) required before sending a reminder. */
const MIN_FREE_GAP_MINUTES_FOR_REMINDER = 30;

function getApiKey() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) {
    throw new Error("Missing ANTHROPIC_API_KEY in environment.");
  }
  return key;
}

function getGoogleConfig() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(process.env.GOOGLE_REFRESH_TOKEN || "").trim();
  const calendarIdsRaw = String(process.env.GOOGLE_CALENDAR_IDS || "").trim();

  if (!clientId) throw new Error("Missing GOOGLE_CLIENT_ID in environment.");
  if (!clientSecret) throw new Error("Missing GOOGLE_CLIENT_SECRET in environment.");
  if (!refreshToken) throw new Error("Missing GOOGLE_REFRESH_TOKEN in environment.");
  if (!calendarIdsRaw) throw new Error("Missing GOOGLE_CALENDAR_IDS in environment.");

  const calendarIds = calendarIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!calendarIds.length) throw new Error("GOOGLE_CALENDAR_IDS was empty.");

  return { clientId, clientSecret, refreshToken, calendarIds };
}

function getSupabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url) throw new Error("Missing SUPABASE_URL in environment.");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in environment.");
  return { url, key };
}

const supabase = (() => {
  const { url, key } = getSupabaseConfig();
  return createClient(url, key);
})();

function buildDebugPayload(payload) {
  const enabled = String(process.env.DEBUG || "").toLowerCase() === "true";
  return enabled ? payload : undefined;
}

function httpTaskError(status, errorMessage, debugDetails) {
  const err = new Error(errorMessage);
  err.status = status;
  err.body = { error: errorMessage, debug: buildDebugPayload(debugDetails) };
  return err;
}

function getTelegramBotToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

function getReminderChatId() {
  const raw = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!raw) throw new Error("Missing TELEGRAM_CHAT_ID in environment.");
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? asNum : raw;
}

function getZonedParts(date, timeZone) {
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
  const parts = dtf.formatToParts(date);
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
  const p = getZonedParts(now, AMERICA_NEW_YORK_TZ);
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 12 * 60 && minutes <= 22 * 60;
}

function getReminderDayStartEtUtc(now = new Date()) {
  const p = getZonedParts(now, AMERICA_NEW_YORK_TZ);
  const isBefore5am = p.hour < 5 || (p.hour === 5 && (p.minute < 0 || p.second < 0));
  // Note: minute/second comparisons above are defensive; p.minute/p.second are non-negative.
  const anchor = new Date(now.getTime());
  if (p.hour < 5) {
    // Move to previous day in ET by subtracting 12h (safe) and re-read parts.
    anchor.setTime(anchor.getTime() - 12 * 60 * 60000);
  }
  const a = getZonedParts(anchor, AMERICA_NEW_YORK_TZ);
  void isBefore5am;
  return makeDateInTimeZone(
    { year: a.year, month: a.month, day: a.day, hour: 5, minute: 0, second: 0 },
    AMERICA_NEW_YORK_TZ
  );
}

async function fetchGoogleAccessToken() {
  const { clientId, clientSecret, refreshToken } = getGoogleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || typeof json?.access_token !== "string") {
    throw new Error(
      `Google token refresh failed: ${response.status} ${JSON.stringify(json).slice(0, 500)}`
    );
  }
  return { accessToken: json.access_token, expiresIn: json.expires_in };
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

async function fetchCalendarBusyIntervals({ timeMin, timeMax }) {
  const { calendarIds } = getGoogleConfig();
  const { accessToken } = await fetchGoogleAccessToken();
  const intervals = [];

  for (const calId of calendarIds) {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    url.searchParams.set("timeMax", timeMax.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "2500");

    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(
        `Google Calendar events fetch failed for ${calId}: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`
      );
    }
    const items = Array.isArray(json?.items) ? json.items : [];
    for (const ev of items) {
      const interval = parseGoogleEventBusyInterval(ev);
      if (interval) intervals.push(interval);
    }
  }

  return mergeIntervals(intervals);
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

async function listTasksByStatus(status) {
  const { data, error } = await supabase
    .from("tasks")
    .select("id,title,urgency,duration,status,created_at,updated_at")
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

async function countRemindersSince(iso) {
  const { count, error } = await supabase
    .from("reminders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", iso);
  if (error) throw new Error(`Supabase count reminders failed: ${error.message}`);
  return Number(count || 0);
}

async function getMostRecentReminder() {
  const { data, error } = await supabase
    .from("reminders")
    .select("id,created_at,task_ids")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase last reminder failed: ${error.message}`);
  return data || null;
}

async function insertReminder(taskIds) {
  const payload = {
    task_ids: Array.isArray(taskIds) ? taskIds : []
  };
  const { data, error } = await supabase
    .from("reminders")
    .insert(payload)
    .select("id,created_at,task_ids")
    .single();
  if (error) throw new Error(`Supabase insert reminder failed: ${error.message}`);
  return data;
}

async function clearAllReminders() {
  const { error } = await supabase.from("reminders").delete().gt("id", 0);
  if (error) throw new Error(`Supabase clear reminders failed: ${error.message}`);
}

async function canSendReminderNow(now = new Date()) {
  if (!isWithinEtSendWindow(now)) return { ok: false, reason: "outside_send_window" };

  const dayStart = getReminderDayStartEtUtc(now);
  const dayStartIso = dayStart.toISOString();
  const sentToday = await countRemindersSince(dayStartIso);
  if (sentToday >= 3) return { ok: false, reason: "daily_cap" };

  const last = await getMostRecentReminder();
  if (last?.created_at) {
    const lastTs = new Date(last.created_at);
    if (Number.isFinite(lastTs.getTime())) {
      const minsSince = (now.getTime() - lastTs.getTime()) / 60000;
      if (minsSince < 120) return { ok: false, reason: "cooldown" };
    }
  }

  return { ok: true, reason: "ok", dayStartIso, sentToday };
}

async function clearAllOpenTasks() {
  const { error } = await supabase
    .from("tasks")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("status", "open");

  if (error) {
    throw new Error(error.message);
  }

  const tasks = await listOpenTasks();
  return { tasks };
}

async function processTaskQuery(query) {
  const apiKey = getApiKey();
  const currentTasks = await listOpenTasks();
  const prompt = [
    "You are a task operation parser named Tod.",
    "Given the user request and current task list, return JSON only with the shape:",
    '{ "operations": [ { operation, targetId, title, urgency, duration }, ... ], "message": "..." }',
    'operation must be one of: "create" | "update" | "delete" | "complete" | "push".',
    "Return one operation per requested change. Multiple operations are allowed in one response.",
    'Use "create" for new tasks, "update" to change title/urgency/duration, "delete" when the user abandons a task (not doing it — maps to cancelled),',
    '"complete" when the user finished a task, "push" when the user defers a task to the next day (maps to pushed; the server reopens pushed tasks as open every day at 5am Eastern).',
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
    'If the user request results in more than one task/action being mentioned in "message" (for example, listing remaining tasks), format that part as a bulleted list using "-" bullets, with each item on its own line (include newline characters in the string). Keep the bullets friendly and meaning-based, not title dumps.',
    'If only one task/action is mentioned, keep "message" as normal prose (no bullet list).',
    "",
    "Important: output JSON only. No prose. No markdown. No code fences.",
    "",
    `Current tasks: ${JSON.stringify(currentTasks)}`,
    `User request: ${query}`
  ].join("\n");

  let claudeResponse;
  try {
    claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (error) {
    throw httpTaskError(502, "I couldn’t update your tasks right now.", {
      type: "anthropic_fetch_failed",
      details:
        error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : "Unknown fetch error"
    });
  }

  if (!claudeResponse.ok) {
    const errorText = await claudeResponse.text();
    throw httpTaskError(claudeResponse.status, "I couldn’t update your tasks right now.", {
      type: "anthropic_api_error",
      status: claudeResponse.status,
      details: errorText.slice(0, 2000)
    });
  }

  const data = await claudeResponse.json();
  const textChunk = data?.content?.find((item) => item.type === "text")?.text;
  if (!textChunk) {
    throw httpTaskError(502, "I couldn’t understand the assistant response.", {
      type: "anthropic_missing_text"
    });
  }

  let parsed;
  try {
    parsed = extractJsonPayload(textChunk);
  } catch (error) {
    throw httpTaskError(502, "I couldn’t understand the assistant response.", {
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
    throw httpTaskError(502, "I couldn’t understand the assistant response.", {
      type: "anthropic_missing_operations",
      details:
        error instanceof Error
          ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
          : "Unknown operations parse error"
    });
  }

  const results = [];
  for (const op of operations) {
    if (op.operation === "create") {
      const { data: row, error } = await supabase
        .from("tasks")
        .insert({
          title: op.fields.title,
          urgency: op.fields.urgency,
          duration: op.fields.duration,
          status: "open"
        })
        .select("id,title,urgency,duration,status,created_at,updated_at")
        .single();

      if (error) {
        results.push({ requested: op, applied: false, error: error.message });
        continue;
      }

      results.push({ requested: op, applied: true, task: row });
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
      const updatePayload = {};
      if (op.fields.title) updatePayload.title = op.fields.title;
      if (op.fields.urgency !== undefined) updatePayload.urgency = op.fields.urgency;
      if (op.fields.duration !== undefined) updatePayload.duration = op.fields.duration;

      if (!Object.keys(updatePayload).length) {
        results.push({
          requested: op,
          applied: false,
          error: "No fields provided to update."
        });
        continue;
      }

      updatePayload.updated_at = new Date().toISOString();

      const { data: row, error } = await supabase
        .from("tasks")
        .update(updatePayload)
        .eq("id", op.targetId)
        .eq("status", "open")
        .select("id,title,urgency,duration,status,created_at,updated_at")
        .single();

      if (error) {
        results.push({ requested: op, applied: false, error: error.message });
        continue;
      }

      results.push({ requested: op, applied: true, task: row });
    } else if (op.operation === "delete") {
      const { data: row, error } = await supabase
        .from("tasks")
        .update({ status: "canceled", updated_at: new Date().toISOString() })
        .eq("id", op.targetId)
        .eq("status", "open")
        .select("id,title,urgency,duration,status,created_at,updated_at")
        .single();

      if (error) {
        results.push({ requested: op, applied: false, error: error.message });
        continue;
      }

      results.push({ requested: op, applied: true, task: row });
    } else if (op.operation === "complete") {
      const { data: row, error } = await supabase
        .from("tasks")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", op.targetId)
        .eq("status", "open")
        .select("id,title,urgency,duration,status,created_at,updated_at")
        .single();

      if (error) {
        results.push({ requested: op, applied: false, error: error.message });
        continue;
      }

      results.push({ requested: op, applied: true, task: row });
    } else if (op.operation === "push") {
      const { data: row, error } = await supabase
        .from("tasks")
        .update({ status: "pushed", updated_at: new Date().toISOString() })
        .eq("id", op.targetId)
        .eq("status", "open")
        .select("id,title,urgency,duration,status,created_at,updated_at")
        .single();

      if (error) {
        results.push({ requested: op, applied: false, error: error.message });
        continue;
      }

      results.push({ requested: op, applied: true, task: row });
    }
  }

  const firstApplied = results.find((r) => r.applied);
  const refreshedTasks = await listOpenTasks();
  return {
    message: normalizeMessage(parsed?.message) || buildFallbackMessageFromResults(results),
    operations: results,
    tasks: refreshedTasks,
    operation: firstApplied?.requested?.operation,
    task: firstApplied?.task
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
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN.");
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
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
  const apiKey = getApiKey();
  const gapEndEt = gapEnd ? getZonedParts(gapEnd, AMERICA_NEW_YORK_TZ) : null;
  const gapEndStr = gapEndEt
    ? `${String(gapEndEt.hour).padStart(2, "0")}:${String(gapEndEt.minute).padStart(2, "0")} ET`
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

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }]
    })
  });

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
  const apiKey = getApiKey();
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

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 220,
      temperature: 0.6,
      messages: [{ role: "user", content: prompt }]
    })
  });

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
  let open;
  let completed;
  let canceled;
  try {
    open = await listOpenTasks();
    completed = await listTasksByStatus("completed");
    canceled = await listTasksByStatus("canceled");
  } catch (err) {
    console.error("Nightly digest: failed to load tasks:", err instanceof Error ? err.message : err);
    return;
  }

  const text = buildNightlyDigestText({ open, completed, canceled });
  try {
    await telegramSendMessage(getReminderChatId(), text);
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
    await telegramSendMessage(getReminderChatId(), text);
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

async function telegramPollingLoop() {
  const token = getTelegramBotToken();
  if (!token || pollingActive) return;
  pollingActive = true;

  while (pollingActive) {
    try {
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
      url.searchParams.set("timeout", "50");
      url.searchParams.set("offset", String(pollingOffset));

      const response = await fetch(url.toString(), { method: "GET" });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok || !Array.isArray(data.result)) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of data.result) {
        pollingOffset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function startTelegramPollingOrThrow() {
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN in environment.");
  }
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

  const { error: deleteError } = await supabase.from("tasks").delete().eq("status", "completed");

  if (deleteError) {
    console.error("Daily rollover: failed to delete completed tasks:", deleteError.message);
  }

  const { error: deleteCanceledError } = await supabase.from("tasks").delete().eq("status", "canceled");

  if (deleteCanceledError) {
    console.error("Daily rollover: failed to delete canceled tasks:", deleteCanceledError.message);
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

function startDailyRolloverCron() {
  cron.schedule(
    "0 5 * * *",
    () => {
      runDailyRollover().catch((err) => console.error("Daily rollover error:", err));
    },
    { timezone: "America/New_York" }
  );
  console.log(
    "Daily rollover scheduled for 5:00 America/New_York (pushed→open, delete completed + canceled)."
  );
}

async function runSmartReminderTick() {
  const now = new Date();
  const debugEnabled = String(process.env.DEBUG || "").toLowerCase() === "true";
  const debug = (...args) => {
    if (debugEnabled) console.log("[smartreminder]", ...args);
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

  const horizonEnd = new Date(now.getTime() + 36 * 60 * 60000);

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
    const until = gap.gapEnd ? getZonedParts(gap.gapEnd, AMERICA_NEW_YORK_TZ) : null;
    const untilStr = until
      ? `${String(until.hour).padStart(2, "0")}:${String(until.minute).padStart(2, "0")} ET`
      : "";
    message = `You’ve got about ${gap.remainingMinutes} minutes free${
      untilStr ? ` (until around ${untilStr})` : ""
    }. If you’re up for it, you could work on ${titles.slice(0, 3).join(" / ")}.`;
  }

  try {
    await telegramSendMessage(getReminderChatId(), message);
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

function startSmartReminderCron() {
  cron.schedule(
    "*/10 * * * *",
    () => {
      runSmartReminderTick().catch((err) => console.error("Smart reminder tick error:", err));
    },
    { timezone: AMERICA_NEW_YORK_TZ }
  );
  console.log(
    "Smart reminders scheduled every 10 minutes (12:00–22:00 ET, ≥30 min free gap, caps + cooldown enforced)."
  );
}

function startNightlyDigestCron() {
  cron.schedule(
    "0 22 * * *",
    () => {
      runNightlyDigest().catch((err) => console.error("Nightly digest error:", err));
    },
    { timezone: AMERICA_NEW_YORK_TZ }
  );
  console.log("Nightly task digest scheduled for 22:00 America/New_York.");
}

function startMorningMessageCron() {
  cron.schedule(
    "25 12 * * *",
    () => {
      runMorningMessage().catch((err) => console.error("Morning message error:", err));
    },
    { timezone: AMERICA_NEW_YORK_TZ }
  );
  console.log("Morning message scheduled for 05:30 America/New_York.");
}

startDailyRolloverCron();
startSmartReminderCron();
startNightlyDigestCron();
startMorningMessageCron();
startTelegramPollingOrThrow();
