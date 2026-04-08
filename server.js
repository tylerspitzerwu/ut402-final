"use strict";

require("dotenv").config();

const express = require("express");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 5500;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const tasks = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function clearTasks() {
  tasks.length = 0;
}

function getApiKey() {
  const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) {
    throw new Error("Missing ANTHROPIC_API_KEY in environment.");
  }
  return key;
}

function buildDebugPayload(payload) {
  const enabled = String(process.env.DEBUG || "").toLowerCase() === "true";
  return enabled ? payload : undefined;
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
  const failed = results.filter((r) => !r?.applied).length;

  const parts = [];
  if (created) parts.push(`Added ${created} ${created === 1 ? "task" : "tasks"}`);
  if (updated) parts.push(`Updated ${updated} ${updated === 1 ? "task" : "tasks"}`);
  if (canceled) parts.push(`Canceled ${canceled} ${canceled === 1 ? "task" : "tasks"}`);
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

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTitleMatch(candidateTitle, targetTitle) {
  const candidate = normalizeTitle(candidateTitle);
  const target = normalizeTitle(targetTitle);
  if (!candidate || !target) return 0;
  if (candidate === target) return 100;
  if (candidate.includes(target) || target.includes(candidate)) return 75;

  const candidateTokens = new Set(candidate.split(" "));
  const targetTokens = target.split(" ");
  const overlap = targetTokens.filter((token) => candidateTokens.has(token)).length;
  return Math.round((overlap / targetTokens.length) * 60);
}

function findBestTaskIndex(targetTitle) {
  if (!targetTitle || !tasks.length) return -1;

  let bestIndex = -1;
  let bestScore = 0;
  let secondBestScore = 0;
  tasks.forEach((task, idx) => {
    const score = scoreTitleMatch(task.title, targetTitle);
    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestIndex = idx;
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  });

  const confidentEnough = bestScore >= 50 && bestScore - secondBestScore >= 10;
  return confidentEnough ? bestIndex : -1;
}

function normalizeOperationPayload(raw) {
  const operationRaw = String(raw?.operation || "")
    .trim()
    .toLowerCase();
  const operation =
    operationRaw === "update" || operationRaw === "delete" ? operationRaw : "create";
  const targetTitle = typeof raw?.targetTitle === "string" ? raw.targetTitle.trim() : "";

  if (operation === "create") {
    return {
      operation,
      targetTitle: "",
      fields: {
        title: normalizeTaskTitle(raw?.title),
        urgency: normalizeUrgency(raw?.urgency),
        duration: normalizeDuration(raw?.duration)
      }
    };
  }

  return {
    operation,
    targetTitle,
    fields: {
      title: typeof raw?.title === "string" ? raw.title.trim() : "",
      urgency: parseOptionalUrgency(raw?.urgency),
      duration: parseOptionalDuration(raw?.duration)
    }
  };
}

app.post("/api/task", async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Query is required." });
    }

    const apiKey = getApiKey();
    const prompt = [
      "You are a task operation parser.",
      "Given the user request and current task list, return JSON only with the shape:",
      '{ "operations": [ { operation, targetTitle, title, urgency, duration }, ... ], "message": "..." }',
      'operation must be one of: "create" | "update" | "delete".',
      "Return one operation per requested change. Multiple operations are allowed in one response.",
      'Use operation "create" for new tasks, "update" for edits to existing tasks, and "delete" for cancel requests.',
      "For update/delete, set targetTitle to the best title phrase identifying the existing task.",
      "For create, targetTitle should be empty.",
      "Urgency must be 1-10, duration in minutes.",
      "",
      'Also include a user-facing "message" string that summarizes what you did in friendly natural language.',
      'Do not mention JSON, operations arrays, fields, or any implementation details in "message".',
      'If multiple changes happen, "message" should summarize them succinctly.',
      "",
      "Important: output JSON only. No prose. No markdown. No code fences.",
      "",
      `Current tasks: ${JSON.stringify(tasks)}`,
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
          max_tokens: 300,
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }]
        })
      });
    } catch (error) {
      return res.status(502).json({
        error: "I couldn’t update your tasks right now.",
        debug: buildDebugPayload({
          type: "anthropic_fetch_failed",
          details:
            error instanceof Error
              ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
              : "Unknown fetch error"
        })
      });
    }

    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text();
      return res.status(claudeResponse.status).json({
        error: "I couldn’t update your tasks right now.",
        debug: buildDebugPayload({
          type: "anthropic_api_error",
          status: claudeResponse.status,
          details: errorText.slice(0, 2000)
        })
      });
    }

    const data = await claudeResponse.json();
    const textChunk = data?.content?.find((item) => item.type === "text")?.text;
    if (!textChunk) {
      return res.status(502).json({
        error: "I couldn’t understand the assistant response.",
        debug: buildDebugPayload({ type: "anthropic_missing_text" })
      });
    }

    let parsed;
    try {
      parsed = extractJsonPayload(textChunk);
    } catch (error) {
      return res.status(502).json({
        error: "I couldn’t understand the assistant response.",
        debug: buildDebugPayload({
          type: "anthropic_invalid_json",
          details:
            error instanceof Error
              ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
              : "Unknown JSON parse error"
        })
      });
    }

    let operations;
    try {
      operations = normalizeOperationListPayload(parsed);
    } catch (error) {
      return res.status(502).json({
        error: "I couldn’t understand the assistant response.",
        debug: buildDebugPayload({
          type: "anthropic_missing_operations",
          details:
            error instanceof Error
              ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
              : "Unknown operations parse error"
        })
      });
    }

    const results = [];
    for (const op of operations) {
      if (op.operation === "create") {
        const task = {
          title: op.fields.title,
          urgency: op.fields.urgency,
          duration: op.fields.duration,
          status: "open",
          timeCreated: new Date().toISOString()
        };
        tasks.unshift(task);
        results.push({ requested: op, applied: true, task });
        continue;
      }

      const targetIndex = findBestTaskIndex(op.targetTitle);
      if (targetIndex === -1) {
        results.push({
          requested: op,
          applied: false,
          error:
            op.operation === "update"
              ? "Could not confidently match a task to update."
              : "Could not confidently match a task to cancel."
        });
        continue;
      }

      const existing = tasks[targetIndex];
      if (op.operation === "update") {
        const task = {
          ...existing,
          title: op.fields.title || existing.title,
          urgency: op.fields.urgency ?? existing.urgency,
          duration: op.fields.duration ?? existing.duration
        };
        tasks[targetIndex] = task;
        results.push({ requested: op, applied: true, task });
      } else {
        const task = { ...existing, status: "canceled" };
        tasks[targetIndex] = task;
        results.push({ requested: op, applied: true, task });
      }
    }

    const firstApplied = results.find((r) => r.applied);
    return res.json({
      message: normalizeMessage(parsed?.message) || buildFallbackMessageFromResults(results),
      operations: results,
      tasks,
      operation: firstApplied?.requested?.operation,
      task: firstApplied?.task
    });
  } catch (error) {
    return res.status(500).json({
      error: "I couldn’t update your tasks right now.",
      debug: buildDebugPayload({
        type: "server_error",
        details:
          error instanceof Error
            ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}`
            : "Unknown server error."
      })
    });
  }
});

app.post("/api/tasks/clear", (req, res) => {
  clearTasks();
  return res.json({ tasks });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
