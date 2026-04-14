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

function getApiKey() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) {
    throw new Error("Missing ANTHROPIC_API_KEY in environment.");
  }
  return key;
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

async function listOpenTasks() {
  const { data, error } = await supabase
    .from("tasks")
    .select("id,title,urgency,duration,status,created_at,updated_at")
    .eq("status", "open")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Supabase list tasks failed: ${error.message}`);
  }
  return Array.isArray(data) ? data : [];
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
    "You are a task operation parser.",
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
    'Write "message" in natural conversational prose: use each task’s meaning, but weave it into full sentences the way you would in speech — paraphrase freely; do not recite or quote the stored task titles verbatim and do not present them as a stiff bulleted title list.',
    'If multiple changes happen, "message" should summarize them succinctly.',
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

function formatTaskListLine(task) {
  const id = typeof task?.id === "string" ? task.id : "";
  const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const title = typeof task?.title === "string" ? task.title : "Untitled";
  const u = task?.urgency;
  const d = task?.duration;
  return `• ${title} (u:${u} · ${d}m · ${shortId})`;
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
}

function startDailyRolloverCron() {
  cron.schedule(
    "0 5 * * *",
    () => {
      runDailyRollover().catch((err) => console.error("Daily rollover error:", err));
    },
    { timezone: "America/New_York" }
  );
  console.log("Daily rollover scheduled for 5:00 America/New_York (pushed→open, delete completed).");
}

startDailyRolloverCron();
startTelegramPollingOrThrow();
