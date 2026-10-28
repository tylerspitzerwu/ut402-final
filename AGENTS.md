# Agent source of truth

This file is the technical and operational source of truth for this repository. Read it before changing behavior, adding features, or touching deployment. Prefer this document over chat history.

Product rules implemented in code are described here: nudge caps, calendar gaps, reminder time resolution and recurrence, and which work is Claude phrasing versus deterministic scheduling. There is no separate product-rules file in the repo; keep this document in sync when those rules change.

## Who this is for

**One person:** Tyler. This is a **personal productivity** system, not a multi-user product, SaaS, or team tool. There is no signup and no user accounts. Access is the env-configured Telegram bot plus a single `TELEGRAM_CHAT_ID` for scheduled messages.

**What “good” means:** seamlessness, **low latency**, **low friction**, and **convenience**. The owner should capture, complete, push, or check tasks in Telegram with as little ceremony as possible—natural language, fast replies, no extra apps, no confirmation mazes, no dashboards to log into.

When choosing among implementations, prefer:

- Fast round-trips (keep Claude calls small; avoid extra model round-trips for one user message).
- Always-on production (Railway with app sleeping disabled) so morning/night jobs and polling just happen.
- Defaults that do the obvious thing rather than asking the user to configure.

Do **not** optimize for multi-tenancy, enterprise auth, admin consoles, or “scale to many users.” Extra abstraction for hypothetical other users is friction.

## What this project is

A personal **Telegram task assistant** plus **scheduled messages** (nudges, morning briefing, nightly digest, daily rollover) and **natural-language reminders** (“remind me at 2pm to call my dad”, “every weekday at 8am”).

It is a **single long-running Node.js process** (`server.js`). It does **not** serve HTTP. It does **not** expose a public URL. Incoming messages arrive by **Telegram long polling** (`getUpdates`). Outbound work is HTTPS to Telegram, Anthropic, Google OAuth/Calendar, and Supabase.

Optional phone-location intake is a separate Supabase Edge Function, `location-update`, with its own HTTPS endpoint. It does not add an HTTP listener or another poller to the Node process. Deploying it and applying its SQL are separate setup steps. With `LOCATION_AWARE_NUDGES=true`, the nudge loop reads the latest position and short coordinate trail only after all existing eligibility checks, fetches Google Nearby Search candidates, and gives Claude the final location suitability decision. It defaults off until explicitly enabled in Railway. Movement and dwell time are evidence for Claude, not deterministic gates. Building footprints are deferred.

The assistant persona in Claude prompts is named **Tod**.

## Runtime shape

```
Tyler (Telegram)  --getUpdates (long poll)-->  Node process (server.js)
                                                    |
                  node-cron (in-process, active timezone)
                                                    |
         +------------------+------------------+----+------------------+
         |                  |                  |                       |
    Anthropic API           Google Calendar     Telegram sendMessage     Supabase
    (task ops JSON +        (busy intervals)    (replies + scheduled)    (tasks, nudges,
     conversation context                          copy)                   reminders,
     + history search)                                                     settings, history)
```

- **Entry:** `npm start` → `node server.js` (`package.json`).
- **Module type:** CommonJS (`"type": "commonjs"`).
- **Node:** pinned to `>=22` via `engines` in `package.json`, so Nixpacks does not silently pick a different major.
- **Secrets:** when run directly, `server.js` loads `.env` with Node's built-in `process.loadEnvFile()` (no `dotenv` dependency); a missing file is ignored and variables already in the environment win. Production injects the same names as environment variables. `.env` is gitignored; never commit it or paste secret values into docs, commits, or chat.

On boot the process:

1. Builds and freezes `config`, validating **every** required environment variable (fails fast on any missing name).
2. Creates a Supabase client.
3. Loads allowlisted runtime settings from Supabase; a read error or invalid stored value fails startup rather than scheduling in the wrong timezone.
4. Reclaims any reminder stuck in `sending` after a crash, returning it to `pending` (`reclaimStuckReminders`). A failure here is logged, not fatal.
5. Registers five `node-cron` jobs in the active timezone, each wrapped in a single-flight guard.
6. Installs `SIGTERM` / `SIGINT` handlers that stop cron and polling, let the message currently being handled and any running cron job finish, then exit 0.
7. Starts the Telegram polling loop.

**Every outbound request has a timeout** (`fetchWithTimeout` + `TIMEOUT_MS`): Anthropic 20s, Google 10s, Supabase 10s (through the SDK's configured fetch), Telegram 10s, and 55s for the long poll, which needs headroom over its own `timeout=50`. This matters more than it looks: handling is serial and single-threaded, so one hung request without a timeout stalls the entire bot for as long as it hangs. Any new call site must go through `fetchWithTimeout`.

There is **no** Express/HTTP listener and **no** `PORT` bind. Do not add a web server unless a host requires a healthcheck. Do not use Trigger.dev or any external scheduler; scheduling stays in this process.

## Hard constraint: one poller

Telegram delivers `getUpdates` to **one** polling client per bot token. Running this process twice (laptop + Railway, two Railway replicas, local + Pi) causes missed or “stolen” updates.

When developing locally, **stop the Railway service** (or whatever is production). When production is live, do not leave `node server.js` running on a laptop.

## Repository layout

| Path | Role |
| --- | --- |
| `server.js` | Entire application: Telegram, Claude, Calendar, cron, Supabase |
| `test/server.test.js` | `node:test` suite for the pure logic: DST and recurrence, reminder time resolution, free-gap math, reply assembly |
| `supabase/functions/location-update/index.mjs` | Standalone authenticated phone-location upload Edge Function |
| `supabase/migrations/20261026000000_owner_location.sql` | Optional location table, access grants, and atomic timestamp-guarded write RPC |
| `supabase/migrations/20261027000000_location_trail.sql` | Adds the latest-three-report trail and updates the existing RPC without changing phone uploads |
| `supabase/config.toml` | Edge Function entrypoint and custom-token authentication configuration |
| `supabase/LOCATION_SETUP.md` | Dashboard deployment and iPhone upload instructions |
| `test/location-update.test.js` | Endpoint authentication, validation, response, and persistence-failure tests with mocked fetch |
| `test/location-nudges.test.js` | Trail/distance/place/assessment validation and nudge workflow tests with mocked network calls |
| `test/workflows.test.js` | Mocked regression checks for natural-language listing, rollover, and once-only / DST reminder delivery |
| `package.json` / `package-lock.json` | Dependencies plus `start` and `test` scripts |
| `.gitignore` | Ignores `.env`, `node_modules`, logs |
| `AGENTS.md` | This file |

There is no frontend, no Dockerfile, no `railway.toml`. Railway Nixpacks detects Node from `package.json`.

`server.js` only loads `.env`, installs signal handlers, and starts `main()` when run directly (`require.main === module`). Requiring it from a test builds config from whatever is in `process.env` and exports the helpers listed at the bottom of the file, with no network activity on import. Nudge workflow tests call the exported tick with mocked network requests. `npm test` needs no credentials and is safe to run while production is polling.

## Environment variables

Application configuration names are read in `server.js`. Production (Railway **Variables** tab) must define the same set. Locally they live in `.env`. `NODE_ENV` is Railway platform metadata, not application configuration.

`buildConfig()` reads and validates **every required variable at boot** and freezes the result, so a missing credential crashes the process immediately instead of surfacing at 05:30 or midday. Nothing re-reads `process.env` at request time.

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes (startup) | Bot API token; long poll + `sendMessage` |
| `TELEGRAM_CHAT_ID` | yes (startup) | Owner chat (`config.ownerChatId`): destination for nudges, morning, nightly digest, and the only chat allowed to change settings or use history |
| `ANTHROPIC_API_KEY` | yes (startup) | Claude Messages API |
| `CLAUDE_MODEL` | no | Default `claude-haiku-5-5` |
| `SUPABASE_URL` | yes (startup) | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (startup) | Server-side access; bypasses RLS. Treat as a secret. |
| `GOOGLE_CLIENT_ID` | yes (startup) | OAuth client for Calendar |
| `GOOGLE_CLIENT_SECRET` | yes (startup) | OAuth secret |
| `GOOGLE_REFRESH_TOKEN` | yes (startup) | Offline token → access token |
| `GOOGLE_CALENDAR_IDS` | yes (startup) | Comma-separated calendar IDs (e.g. `primary,user@gmail.com`) |
| `DEBUG` | no | `true` enables extra nudge-tick and reminder-tick logs. Production should be `false`. |
| `LOCATION_AWARE_NUDGES` | no | `true` enables the location assessment after existing nudge checks. Default `false`; only `true` / `false` are accepted (case-insensitive). Requires both location migrations, phone uploads, and Google Places API (New). |
| `GOOGLE_MAPS_API_KEY` | when location mode is enabled | Server-only key restricted to **Places API (New)**. Missing/empty fails startup when `LOCATION_AWARE_NUDGES=true`; unused when disabled. Separate from Calendar OAuth and the phone upload token. |
| `NODE_ENV` | no | Platform-only; set `production` on Railway. `server.js` does not read it. |

Every incoming Telegram text message is handled as **natural language** for **any chat** that messages the bot. There are no slash-command shortcuts. **Scheduled** messages always go to `TELEGRAM_CHAT_ID`, not necessarily the last chatter.

## Data: Supabase

Five existing tables, plus optional `owner_location` after its migration is applied. The service role key is server-only: the Node process and the optional Supabase Edge Function use it; the phone never receives it. The `CREATE TABLE` / index SQL below describes the existing hosted schema; the location migration is the source for that optional table and RPC. Keep both in sync when the tables change.

### `tasks`

Columns used in code: `id` (UUID), `title`, `urgency` (1–10), `duration` (minutes), `status`, `created_at`, `updated_at`.

```sql
create table public.tasks (
  id uuid not null default gen_random_uuid(),
  title text not null,
  urgency integer not null default 5,
  duration integer not null default 30,
  status text not null default 'open'::text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint tasks_pkey primary key (id),
  constraint tasks_status_check check (
    status = any (
      array[
        'open'::text,
        'completed'::text,
        'canceled'::text,
        'pushed'::text
      ]
    )
  )
);

create index if not exists tasks_status_created_at_idx
  on public.tasks using btree (status, created_at desc);
```

**Status machine**

| Status | Meaning |
| --- | --- |
| `open` | Active to-do. Listed, editable, eligible for nudges/morning. |
| `completed` | User finished it. Hidden from open lists. Deleted at the 05:00 local rollover. |
| `canceled` | User abandoned it (`delete` op, including cancel-all). Deleted at rollover. |
| `pushed` | Deferred to tomorrow. Reopened to `open` at the 05:00 local rollover. |

For every natural-language user query, Claude receives one read-only snapshot of every currently retained task row (all statuses), with `created_at` and `updated_at`, ordered newest first. `created_at` is when the task was added. For a completed, canceled, or pushed row, `updated_at` is when that status was applied: non-open rows cannot change again before rollover, so that timestamp is a reliable status-change time. “Today” for task-date questions starts at the active timezone’s **05:00 rollover**, not midnight. Completed and canceled rows remain available for these answers only until the next rollover deletes them.

Claude may only target **open** rows for update/delete/complete/push, even though completed, canceled, and pushed rows are visible as read-only context. The `.eq("status", "open")` database guards remain authoritative. Create always inserts `status: "open"`. Defaults if Claude omits numbers: urgency `5`, duration `30`, title `"Untitled Task"`.

### `nudges`

Send log for **nudges** (gap-based task suggestions), so daily caps survive restarts. This table is not user-scheduled timed reminders.

Columns used: `id`, `created_at`, `task_ids` (array of task UUIDs suggested in that send). Inserts do not set `created_at` in application code (DB default). The primary-key constraint is still named `reminders_pkey` from a prior table rename.

```sql
create table public.nudges (
  id bigint generated by default as identity not null,
  created_at timestamp with time zone not null default now(),
  task_ids uuid[] null,
  constraint reminders_pkey primary key (id)
);
```

Daily cap counts rows with `created_at >=` the current 05:00 local day start (`getLocalDayStartUtc`). Cooldown uses the most recent row’s `created_at`. Both checks use a **single** query for rows since that day start (`listNudgeSendsSince`). Restricting the cooldown check to today is safe because the local send window opens at 12:00, so any nudge from a previous day is already hours past the 120-minute cooldown.

Rollover **deletes all `nudges` rows**. That delete filters on `.not("id", "is", null)` rather than comparing `id` to a number, so it works whether `id` is a bigint or a UUID.

### `scheduled_reminders`

User-scheduled timed reminders, one row per reminder. Unlike `nudges` (a send log for suggestions), these are explicit requests: “remind me at 2pm to call my dad”. Reminders are **standalone** and never read or write `tasks`.

```sql
create table public.scheduled_reminders (
  id uuid not null default gen_random_uuid(),
  chat_id text not null,
  body text not null,
  status text not null default 'pending'::text,
  next_due_at timestamp with time zone not null,
  recurrence jsonb null,
  time_zone text not null,
  attempts integer not null default 0,
  occurrences_sent integer not null default 0,
  last_fired_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint scheduled_reminders_pkey primary key (id)
);

create index if not exists scheduled_reminders_due_idx
  on public.scheduled_reminders using btree (status, next_due_at);
```

There is deliberately **no** status CHECK constraint (unlike `tasks`); status validity is enforced in Node by `REMINDER_STATUS`.

**Status machine**

| Status | Meaning |
| --- | --- |
| `pending` | Live. Eligible to fire, and the only status any write may target. |
| `sending` | Claimed by the firing job. Crash-recovery only; reclaimed to `pending` at boot. |
| `sent` | A one-off was delivered. |
| `canceled` | User canceled it (`cancel_reminder`). Cancels a whole series. |
| `failed` | Telegram send failed after `REMINDER_MAX_SEND_ATTEMPTS` (3) attempts, or stored recurrence is invalid. |
| `exhausted` | A series reached its `until` date or `count`. |

`recurrence IS NULL` is the one-off/series discriminator, and the firing sweep is identical for both. **One-off** reminders store an absolute instant in `next_due_at` that never moves. For a **series**, the recurrence rule is the source of truth and `next_due_at` is a recomputed cache — see the reminders section below.

`recurrence` is a validated structured object, not RFC 5545. `normalizeRecurrence` rejects anything outside this shape rather than coercing it, so a misread schedule cannot quietly become a different one:

```json
{
  "freq": "daily | weekly | monthly | yearly",
  "interval": 1,
  "byWeekday": [1, 2, 3, 4, 5],
  "byMonthDay": 15,
  "month": 3,
  "hour": 8,
  "minute": 0,
  "until": "2026-09-01",
  "count": 10
}
```

`freq` and `hour` are required; `weekly` requires `byWeekday` (0 or 7 is accepted as Sunday on input, then stored canonically as 0), `monthly` requires `byMonthDay`, and `yearly` requires `month` and `byMonthDay`. `interval` defaults to 1 and is capped at 366; `count` is capped at 1000. There is intentionally **no sub-daily frequency**, so “remind me every minute” is unrepresentable and is refused rather than clamped.

Candidate expansion is intentionally bounded by `RECURRENCE_SEARCH_LIMIT`: 400 days for daily/weekly rules, 60 months for monthly rules, and 12 years for yearly rules. A structurally valid interval with no match inside that horizon is refused with “That repeating schedule has no upcoming date.”

Only `pending` rows may be mutated by user operations. Every reminder write carries a status guard: single-row writes go through `markReminder(id, fromStatus, payload)` / `updatePendingReminder`, and the batched cancel and boot-time reclaim filter on status directly. The guard exists for the same reason task writes carry `.eq("status", "open")`: it is what stops a canceled or already-fired reminder from being revived. A batched cancel detects stale or invented ids by diffing the returned `id` set against the requested one.

Retention: the 05:00 rollover deletes only **terminal** rows older than seven days (`REMINDER_RETENTION_MS`). A `pending` reminder can legitimately be weeks or months away and must never be swept up the way `clearAllNudgeSends` empties its whole table.

### `bot_settings`

Persists the allowlisted preferences that may be changed through natural-language Telegram messages. Columns: `key` (text primary key), `value` (jsonb), `updated_at` (timestamp).

```sql
create table public.bot_settings (
  key text not null,
  value jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint bot_settings_pkey primary key (key)
);
```

The first supported key is `timezone`, stored as a canonical IANA identifier such as `America/Los_Angeles` or `America/New_York`. If its row is absent, the code defaults to `America/Los_Angeles`. `TIME_ZONE_ALIASES` is a Node-side fallback for common US names and abbreviations even though the Claude prompt asks for canonical IANA names. Unknown setting keys are ignored; invalid values for known settings fail startup.

Credentials remain in frozen environment-backed `config`; preferences live in a separate mutable in-memory settings object loaded from this table. A setting change is normalized and validated, upserted first, and only then applied in memory. Adding a future natural-language preference requires an explicit entry in the settings registry with validation and any apply side effect—Claude cannot invent keys or arbitrary behavior.

### `chat_messages`

Stores the configured owner chat’s user-visible conversation for an always-on recent context window and on-demand Claude search. Columns used in code: `id` (UUID), `turn_id` (UUID), `chat_id` (text), `telegram_message_id` (nullable bigint), `role` (`user` or `assistant`), `kind`, `content`, `created_at`, plus the generated `search_vector` used by PostgreSQL full-text search.

```sql
create table public.chat_messages (
  id uuid not null default gen_random_uuid(),
  turn_id uuid not null,
  chat_id text not null,
  telegram_message_id bigint null,
  role text not null,
  kind text not null default 'conversation'::text,
  content text not null,
  created_at timestamp with time zone not null default now(),
  search_vector tsvector generated always as (
    to_tsvector('english'::regconfig, coalesce(content, ''::text))
  ) stored,
  constraint chat_messages_pkey primary key (id),
  constraint chat_messages_role_check check (
    role = any (array['user'::text, 'assistant'::text])
  )
);

create index if not exists chat_messages_chat_time_idx
  on public.chat_messages using btree (chat_id, created_at desc);

create index if not exists chat_messages_search_idx
  on public.chat_messages using gin (search_vector);
```

Interactive user/reply pairs share a `turn_id` and are inserted together only **after** the complete logical reply has been sent successfully to Telegram. This keeps the normal response path fast and prevents unsent assistant text from entering history. Store the original user text and exact user-visible reply, not raw Claude JSON, operations, tool calls, or debug payloads. A Telegram reply split into several 4096-character sends remains one assistant history row.

Scheduled messages are stored as assistant-only turns with `kind` equal to `nudge`, `morning`, `digest`, or `reminder`, and are eligible for the recent context window. History writes, recent reads, and searches are owner-only: chats other than `TELEGRAM_CHAT_ID` continue to work but are neither stored nor given access to conversation history. A fired reminder for a non-owner chat is delivered, but not stored: `persistScheduledChatMessage` always writes as the owner, so it is only called for the owner chat. The owner check lives with the callers that make the decision (`dispatchTelegramMessage`, `processUserQuery`, `sendReminderMessage`); the `chat_messages` helpers trust it.

Every owner query reads up to `CONVERSATION_CONTEXT_MAX_MESSAGES` (20) messages no older than `CONVERSATION_CONTEXT_MAX_AGE_MS` (three hours), in parallel with the task and reminder snapshots. A read failure is logged and degrades to an empty context window rather than failing the query. Rows are reordered chronologically with `user` before `assistant` when timestamps tie, then leading assistant-only rows are dropped so the Anthropic message history begins with a user turn. Claude receives these rows as real `user` / `assistant` messages; static operating instructions use the request’s top-level `system` field, and the latest user message carries the current clock, snapshots, settings, and request.

The `search_chat_history(p_chat_id, p_query, p_since, p_before)` RPC returns matching turns ordered by relevance and recency. Claude’s tool takes an optional `query`, `since`, and `before` for an explicit prior-conversation topic or time-range lookup that the recent context does not answer, defaulting to the rolling seven days. There is **no result-count limit**. Node pages through PostgREST responses until every matching row has been loaded, then re-filters each row to the allowed interval so the other message in a matching turn cannot leak in if it falls outside the seven-day window. Both Node and the RPC clamp access to seven days, and the 05:00 rollover physically deletes older rows.

**Source-control gap:** the exact hosted SQL definition of `search_chat_history` is not present in this repository. The owner must export it from Supabase before this schema can be recreated from source; do not invent a replacement because ranking or boundary differences could change behavior.

### Optional `owner_location` intake

The initial table/grants/RPC SQL is in `supabase/migrations/20261026000000_owner_location.sql`. Apply it once for a new install, then apply `supabase/migrations/20261027000000_location_trail.sql`. Existing installs apply only the new trail migration. `owner_location` has `id` (boolean primary key constrained to true), `latitude` and `longitude` (range-checked double precision), `reported_at` (phone report timestamp), `received_at` (database timestamp), and `trail` (JSONB array constrained to at most three entries). Each trail entry contains the same latitude, longitude, reported_at, and received_at fields. It remains one singleton row, now with a short recent trail rather than a full location-history table. This does not promise deletion from infrastructure backups or platform logs.

Row Level Security is enabled without public policies. `public`, `anon`, and `authenticated` have no table or RPC privileges. Only `service_role` can read/write it or invoke `record_owner_location(p_latitude, p_longitude, p_reported_at)`. That RPC uses an atomic upsert and updates only if `reported_at` is newer; delayed/duplicate uploads cannot overwrite a newer position or append trail entries. On an accepted upload it appends the report, discards entries more than 30 minutes before the new report, and retains only the newest three in chronological order. The new migration seeds the trail from any existing latest row. An outage longer than that span starts a new trail on the next upload. Old samples are pruned on subsequent uploads, not by an independent timer. The RPC signature and return boolean are unchanged, so the existing phone Shortcut and deployed Edge Function need no changes.

The separate `location-update` Edge Function accepts only POST JSON containing numeric `latitude` / `longitude` and `reported_at` as ISO 8601 with seconds and an explicit timezone. Bodies are limited to 4096 bytes. Reports older than 24 hours or more than five minutes in the future are refused. `reported_at` is not proof of a fresh GPS fix; the nudge consumer separately checks freshness and tells Claude about uncertainty.

The phone sends `Authorization: Bearer <token>`. Set `LOCATION_UPLOAD_TOKEN` to a random secret of at least 32 characters in **Supabase Edge Function secrets**, not Railway variables or frozen Node `config`. Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the function. Platform JWT verification is disabled for this function because the phone token is not a Supabase login JWT; the handler verifies its dedicated token before parsing or persisting coordinates. Never put a service-role key on the phone.

The function's sole outbound request goes through its own `fetchWithTimeout` with a ten-second timeout, including response-body consumption. Successful requests return `{"ok":true,"saved":true}` (or `saved:false` for an ignored duplicate/older report); failures use generic responses and never echo database errors, coordinates, or tokens. No Telegram or Claude calls happen on upload. Existing nudge gates, one-off reminders, and recurring reminders are unchanged; the optional nudge location veto is described below.

## Telegram interaction

Polling: `getUpdates` with `timeout=50`, `limit=10`, `allowed_updates=["message"]`, offset advanced per `update_id`. Only `message.text` is handled (no photos, callbacks, etc.). On HTTP/API failure the loop waits 3s and retries.

Handling is **strictly serial**: the loop finishes one message (Claude call included) before fetching the next batch, which keeps replies in order. Do not make this concurrent without a reason. Hung-request stalls are handled by timeouts, not by this serial loop.

Every non-empty text message goes to `processUserQuery`. There are no `/list`, `/settings`, `/help`, `/start`, or `/clear` handlers: listing tasks, reading settings, help, Telegram’s automatic `/start`, and canceling every open task are ordinary Claude requests.

Claude must finish through the structured `submit_operations` tool, whose input contains task, setting, and reminder operations plus a user-facing `message`. This process validates and applies the operations to Supabase, then sends the response. Task prose comes from Claude (or a fallback). Setting and reminder confirmations come from deterministic apply results so the bot cannot claim a failed write succeeded. Cancel-all is one `delete` per currently open task, batched by `applyTaskOperations`.

**Errors.** Only a `UserFacingError` message is ever sent to Telegram; it marks text written for Tyler (validation messages, "I couldn’t understand the assistant response.", and so on). Any other failure — a Supabase read, an Anthropic 400, a timeout — is logged with its cause chain (`errorMessage`) and the user gets a generic "I couldn’t handle that request right now." Internal error text never reaches Telegram or chat history. Every Anthropic request goes through `postAnthropic`, which puts the HTTP status and response body in the thrown error, so a rejected request is visible in the logs rather than only as the generic reply.

For the owner chat, the first `processUserQuery` Claude request sends the bounded recent conversation and exposes both `search_chat_history` and `submit_operations`. Tool choice is mandatory and parallel use is disabled: Claude either finishes immediately through `submit_operations` or performs one warranted search beyond the recent window. After a search, the second request preserves the same system prompt and conversation, exposes and forces only `submit_operations`, and cannot search again. Non-owner chats receive no conversation context and only the forced submit tool.

Recent conversation is supplied automatically so omitted objects, actions, and antecedents can be resolved without a second Claude call. On-demand search is reserved for explicit prior-conversation topic or time-range requests that the recent context does not answer; it is not used for standalone requests or task-date questions answerable from structured task timestamps. The server, not Claude, supplies the owner chat ID and clamps requested timestamps. Recent and searched messages are context only: old requests do not authorize new task operations. If several antecedents remain plausible, Claude submits no operation and asks for clarification.

**Operations Claude may emit:** `create` | `update` | `delete` | `complete` | `push` | `set_setting` | `create_reminder` | `update_reminder` | `cancel_reminder`.

- `delete` → status `canceled` (not a SQL DELETE).
- `complete` → `completed`.
- `push` → `pushed` (comes back at 05:00 in the active timezone).
- `set_setting` → validates and upserts one allowlisted `bot_settings` key. Only messages from the configured `TELEGRAM_CHAT_ID` may mutate global settings.
- `create_reminder` → inserts a `pending` row in `scheduled_reminders`, delivered back to the chat that asked.
- `update_reminder` / `cancel_reminder` → target one `pending` row by `reminderId`. Canceling a repeating reminder cancels the whole series; there is no per-occurrence skip.

`applyTaskOperations` batches **task** operations to keep the reply fast: **one** insert for all creates, **one** update per destination status (`.in("id", ids).eq("status", "open")`), and one update per distinct field payload for `update` ops. Updates run before status transitions so “rename X and mark it done” applies both. Since batched writes cannot use `.single()`, a stale or invented `targetId` is detected by diffing the returned `id` set against the requested one, not by a zero-row error. Keep the `.eq("status", "open")` guard on every task write: it is what stops Claude from reviving a completed, canceled, or pushed task. Setting and reminder writes go through their own apply paths.

Unknown operation names are rejected rather than coerced into task creation. The operation enum in the tool schema and the prompt are both generated from `USER_OPERATIONS`, so they cannot drift. The structured submission schema requires an operations array and a friendly task `message` without IDs, urgency, or duration. Multi-task replies use `- ` bullets. For setting-only and reminder-only replies, Claude should leave `message` empty because Node writes the confirmation. If `message` is omitted entirely, that is tolerated rather than fatal: Node still writes setting and reminder lines, and task replies fall back to a deterministic summary. Only a missing operations array is unrecoverable.

**Reminder parsing split.** Claude extracts intent only; Node owns every clock. Claude sends a local wall clock (`dueLocal` as `YYYY-MM-DDTHH:MM`), a relative `inMinutes`, or a `recurrence` object — never a UTC timestamp and never an offset it computed itself. The prompt is given the current **local** time and weekday so no conversion is needed. Node then resolves the wall clock through `resolveZonedWallClock`, applies the rules below, and writes the row.

- A bare clock time that already passed today rolls forward one local day; an explicitly past **date** is refused instead of being shifted.
- Vague anchors resolve to morning 09:00, afternoon 13:00, evening 19:00, night 21:00.
- A reminder request with no time, date, delay, or schedule creates nothing and asks for a time. It must not be silently turned into a task or given a guessed time.
- One-offs further out than five years (`REMINDER_MAX_LEAD_MS`) are refused as a likely misparsed year.
- Reminder bodies are whitespace-normalized and silently truncated to 500 characters (`REMINDER_MAX_BODY_LEN`).

Reminder confirmations are **deterministic Node output** built from what was actually written (`buildReminderScheduleMessage`), for the same reason setting confirmations are: the bot must never claim a 2pm reminder exists when the insert failed. Echoing the resolved time back is also the only way a misparse gets caught, since a wrong reminder time is otherwise invisible until it is too late. Claude is explicitly told not to restate a reminder time.

Replies longer than 4096 characters are split (`splitTelegramText`).

## Scheduled jobs (`node-cron`, active timezone)

The default timezone is `America/Los_Angeles`, but the owner can change it through natural language (for example, “I’m in Eastern time now”). All five jobs are then stopped and recreated immediately in the new timezone, and recurring reminders are recomputed.

| Cron | Local wall clock | Function | Behavior |
| --- | --- | --- | --- |
| `0 5 * * *` | 05:00 | `runDailyRollover` | `pushed` → `open`; **delete** `completed` and `canceled`; **delete all** `nudges`; delete chat history older than seven days; delete **terminal** reminders older than seven days |
| `30 5 * * *` | 05:30 | `runMorningMessage` | Claude morning copy from **open** tasks (fallback if Claude fails); send to `TELEGRAM_CHAT_ID` |
| `*/10 * * * *` | every 10 min | `runNudgeTick` | Nudge (see below) |
| `0 22 * * *` | 22:00 | `runNightlyDigest` | Deterministic recap: completed / canceled / still open; **not** Claude |
| `* * * * *` | every minute | `runReminderTick` | Deliver due reminders (see below); **not** Claude |

Jobs are registered from the `SCHEDULED_JOBS` table and wrapped in `runExclusive`, which **skips** a tick if the previous run of that same job is still in flight (it does not queue it). This also protects a timezone reschedule from overlapping an already-running old tick.

If a job throws, it is logged; the process stays up.

**`node-cron` stays on v3 deliberately.** v4's scheduler runs a repeated fall-back hour only once, so a sub-hourly schedule "can pause for up to the length of the DST shift" (v4 README). For the every-minute reminder tick that is up to an hour of late reminders once a year. Do not upgrade without moving the reminder tick to a UTC schedule. `runExclusive` is kept rather than v4's `noOverlap` because shutdown needs the in-flight promises.

## Reminders (fully deterministic)

Implemented in `runReminderTick` / `fireOneOffReminder` / `fireRecurringReminder`. The tick selects `pending` rows with `next_due_at <= now()` and handles them serially. Delivery text is a plain `Reminder: <body>` and the body was finalized when the reminder was created, so **no Claude call happens at fire time**: no latency and no failure mode at 2pm.

**Reminders deliberately bypass every nudge gate.** No 12:00–22:00 window, no daily cap, no cooldown, no calendar-busy suppression, and they do not count toward the nudge cap. The user asked for this message at this time; second-guessing it is exactly the friction this project avoids. Do not "unify" the reminder and nudge send paths.

**Delivery is once-only, by claiming before sending.** A one-off is first moved `pending → sending` with the status guard; if the guard matches nothing (canceled in the meantime) the tick skips it. Only then is Telegram called. This is deliberately *not* the `nudges` table's send-then-record pattern, which accepts a double-send. A send failure increments `attempts` and returns the row to `pending`; at 3 attempts it becomes `failed`. A crash between claiming and sending leaves the row in `sending`, and `reclaimStuckReminders` returns it to `pending` at boot. If the crash happened after Telegram accepted the send, that reclaim can duplicate the message. That duplicate is the accepted cost of never silently dropping one. A graceful shutdown waits for a running tick, so a redeploy does not cause it; the `sending → sent` write is itself guarded on `sending`.

**A series advances before it sends.** `fireRecurringReminder` writes the next occurrence (or `exhausted`) *first*, then delivers. A crash therefore costs one message instead of leaving a row that re-fires every minute. Because the row jumps straight to the next occurrence strictly after `now`, an outage spanning many missed occurrences delivers **one** message, not a burst — a three-day gap in a daily 8am reminder does not produce three sends. A late one-off, by contrast, always fires whenever the process comes back.

**Recurrence is expanded in wall-clock terms, never by adding milliseconds.** `computeNextOccurrence` walks candidate local dates and resolves each through `resolveZonedWallClock`. Adding 86 400 000 ms to the previous instant would silently shift “every day at 8am” by an hour at each DST transition. Three edges are handled explicitly:

- **Spring forward:** a rule for 02:30 names a wall clock that does not exist that day. `makeDateInTimeZone` cannot converge, so the round trip is verified and `findFirstInstantAtOrAfterWallClock` binary-searches the first instant the clock actually reaches (03:00).
- **Fall back:** 01:30 happens twice. Requiring the next instant to be strictly greater than the previous one over distinct local dates yields exactly one fire.
- **Month end:** `byMonthDay: 31` clamps to the last day of a short month (February 28) rather than skipping that month. `interval > 1` phase is anchored to `created_at`, so “every other Monday” keeps its parity across recomputes.

**Timezone semantics differ by kind, on purpose.** A one-off reminder means an absolute instant and never moves when the timezone setting changes. A recurring reminder means a local wall clock, so `rescheduleRecurringReminders` recomputes every live series when the timezone changes and updates its `time_zone`. Recomputing from `now` also skips any occurrence that the zone change would make already due: moving Eastern → Pacific shifts an 8am series earlier in absolute time, and without that skip it would fire immediately. If that recompute fails, the timezone change still succeeds and `fireRecurringReminder` self-heals. A row whose `time_zone` no longer matches the active zone is rezoned and skipped for that tick instead of firing at the old wall clock.

## Nudges (deterministic gates, optional Claude location veto, Claude phrasing)

Implemented in `runNudgeTick` / `canSendNudgeNow`. Product intent: suggest work only during real free time, about tasks that **fit the current gap**. Telegram copy stays suggestive prose; do not call these “nudges” in the user-facing text.

**Eligibility (all must pass), in order:**

1. Wall clock in the active timezone is between **12:00 and 22:00** inclusive (`isWithinNudgeSendWindow`).
2. Fewer than **3** `nudges` rows since **05:00 local** today (`MAX_NUDGES_PER_DAY`, `getLocalDayStartUtc`).
3. At least **120 minutes** since the latest nudge send `created_at` (`NUDGE_COOLDOWN_MINUTES`; uses the most recent row since the 05:00 day start).
4. Google Calendar: current time is **not** inside a busy interval.
5. Remaining free gap until next busy block (or the fetch horizon) is **≥ 30 minutes** (`MIN_FREE_GAP_MINUTES_FOR_NUDGE`).
6. At least one **open** task with `duration` ≤ remaining gap minutes.

Then pick up to **3** eligible tasks, highest `urgency` first (`pickTopTasksThatFit`). With location mode disabled, Claude writes 1–3 suggestive sentences; on Claude failure, a template fallback is sent. With location mode enabled, the additional location veto below decides whether any copy may be sent. After a successful Telegram send, insert a `nudges` row (even if persist fails, the user already got the message — next tick may double-send if insert failed).

**Optional location veto (`LOCATION_AWARE_NUDGES=true`):**

- Only after gates 1–6 and task selection, read the singleton `owner_location` row including its trail in one query. No location read, Google Nearby Search, or location-specific Claude call happens on an ineligible tick. Uploading coordinates does not trigger a tick.
- Require valid numeric coordinates and both phone `reported_at` and database `received_at` no older than **20 minutes** (`LOCATION_MAX_AGE_MS`), allowing at most five minutes of future clock skew. Missing, stale, invalid, or unreadable location skips the tick. The timestamps describe report freshness, not independently verified GPS-fix accuracy.
- `buildLocationContext` validates historical reports, discards samples older than 40 minutes from now or inconsistent with the latest row, deduplicates timestamps, and sends at most three chronological reports including the current row. It computes observation span, maximum pairwise separation, net displacement, summed sampled path, and each segment's elapsed time, straight-line displacement, and interval-average displacement rate. Those rates are not current speed, and GPS noise or reused fixes can distort them. Out-and-back movement remains visible even when net displacement is zero. There is **no minimum dwell time, sample count, stationary-radius rule, or deterministic movement/uncertainty veto**: Tyler explicitly chose to let Claude weigh the evidence. A single fresh report is allowed.
- `fetchNearbyPlaces` calls `POST https://places.googleapis.com/v1/places:searchNearby` once, after validating current location, through the ten-second Google timeout. Initial technical defaults are **150 meters**, **10 results**, ranked by **DISTANCE**, with no type filter. The field mask is exactly `places.id,places.displayName,places.location,places.primaryType,places.types` (Nearby Search Pro fields; no wildcard, reviews, or enterprise fields). These are distance-ranked POI candidates, not exhaustive buildings, footprints, or proof of occupancy. Invalid/out-of-radius/duplicate entries are discarded and the remaining candidates are sorted by computed straight-line distance. An empty successful response remains unknown-place evidence for Claude; it is not automatically rejected or interpreted as home. An API failure skips the tick without a model call or web-search fallback.
- `generateLocationAwareNudge` uses the existing Claude model/key in **one** Messages API request, max_tokens **500**, with only the forced `submit_nudge_decision` client tool. It receives the raw coordinates/trail and measured summary, nearby place names/categories/coordinates/distances, current local clock, previously computed calendar gap, and selected tasks. Nearby data and task titles are untrusted context. Claude weighs ambiguity, recent movement, and task suitability; it must not claim a workout, driving, home ownership, or exact indoor position, or invent footprints/accuracy. Libraries/study spaces/cafes may suit study tasks, while a likely gym/appointment/travel context may be inappropriate. No web search or second model round-trip is used.
- The submission contains `send`, descriptive `confidence` (`high` / `medium` / `low`), `reason` (`suitable` / `moving` / `unsuitable_place` / `uncertain`), `placeIds`, and `message`. `parseLocationNudgeResponse` requires a completed `tool_use` response with exactly one matching tool call, typed fields, known candidate IDs (an empty list is allowed), and `send:true` iff the reason is `suitable`. A send requires a nonempty message capped at 1000 characters. Claude's confidence does **not** independently veto its send decision. Malformed/truncated responses and timeouts skip; there is no model continuation or in-tick retry.
- A passing assessment writes the friendly 1–3 sentence task suggestion in the **same request**. It may only veto an otherwise eligible nudge; it cannot override caps, calendar gates, scheduling, or mutate any state. The final message omits coordinates, addresses, venue names, sources, and tracking details. Google place results are used only in memory for that assessment; they are not cached or persisted. Raw assessment/place/trail payloads are neither logged nor stored in conversation history; failures use a generic log line with only the HTTP status when available. No Google Maps data is displayed in Telegram.
- Before sending, recheck cap/cooldown/window, timezone, report freshness, and the remaining gap against the previously fetched calendar intervals. If the chosen tasks no longer fit, skip. This does not refetch calendars to detect newly added events during the assessment.
- In location mode there is **no template fallback** on assessment failure, because that would bypass the veto. Skips do not count toward the three delivered nudges per day and do not start the send cooldown. The next ten-minute tick can reassess; there is no separate location retry cache or cooldown.
- One-off and recurring timed reminders, morning copy, and nightly digest do not use location. No location data is added to ordinary task conversations.
- Building footprints, road matching, phone activity sensors, Driving Focus, and other device-context signals are **not implemented**. Tyler chose a coordinate-only first version with Nearby Search and trails.

**Calendar “busy” rules** (`parseGoogleEventBusyInterval`):

- Timed events with `start.dateTime` / `end.dateTime` only.
- Ignore **all-day** (`start.date` / `end.date`).
- Ignore **cancelled** events.
- Ignore events where the **self** attendee `responseStatus` is `declined`.
- Fetch every ID in `GOOGLE_CALENDAR_IDS` **in parallel**, following `nextPageToken`, then merge overlapping intervals.
- Horizon: now + **6 hours** (`CALENDAR_HORIZON_HOURS`).

The horizon is deliberately short. Every gate compares against 30 minutes or less, so a longer window cannot change any send/skip decision — it could only change how much free time is reported.

The end of the horizon is **not** a calendar event. `computeCurrentFreeGap` returns `gapEndsAtEvent`. The nudge copy (from Claude and from the fallback) only gives a free-until time and a minute count when a real busy block ends the gap. When the horizon is empty, it just says the calendar is clear for the next few hours. Free-until times use the same `2:30 PM` wording as reminder confirmations (`formatZonedClock`). Otherwise a 4:30 PM nudge would say “free until 10:30 PM” only because 10:30 PM is where the 6-hour fetch window ends.

Requests send a `fields` mask (`CALENDAR_FIELDS_MASK`) covering only what `parseGoogleEventBusyInterval` reads, with `maxResults=250` per page. Widening the parser means widening the mask, or the new field will silently arrive as `undefined`.

OAuth: refresh token → `https://oauth2.googleapis.com/token`, then Calendar Events list API. The access token is **cached** in memory until 5 minutes before its `expires_in`, and dropped on a `401` so the next tick re-fetches.

## Claude usage

| Call | Role | Must not do |
| --- | --- | --- |
| `processUserQuery` | Parse NL → structured `submit_operations`; read all retained task statuses/timestamps and pending reminders; include a bounded owner conversation window and optionally search older owner history once; max_tokens 800 | Apply DB writes, validate settings, claim setting success, mutate non-open tasks or non-pending reminders, convert timezones, state a reminder time, treat prior messages as current instructions, or search history for standalone/task-date requests |
| `generateNudgeCopy` | Phrase a nudge; max_tokens 200 | Decide whether to send, caps, or calendar math |
| `generateLocationAwareNudge` | Optional location suitability decision from Nearby Search candidates and recent coordinate trail, plus nudge wording in one Messages request; max_tokens 500 | Override deterministic gates, equate nearest POI with occupancy, invent activity/home/footprints, mutate any state, expose location details in Telegram copy |
| `generateMorningCopy` | Phrase morning briefing; max_tokens 660 | Choose which tasks to mention, or invent scheduling |

Keep **scheduling, caps, gap math, time-zone conversion, recurrence expansion, and persistence in deterministic code**. Do not move those decisions into Claude. The explicitly enabled location veto is the sole exception allowing Claude to suppress an otherwise eligible nudge. Reminder delivery involves no Claude call at all.

Anthropic: `POST https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`, `x-api-key`.

## Deployment (Railway)

**Host:** Railway Hobby, GitHub-connected to this repo (`main`). Auto-deploys on push to `main`.

**Build/start:** Nixpacks, `npm start` → `node server.js`. No Dockerfile.

**Required Railway settings:**

- All env vars listed above in the service **Variables** (not in git).
- **Hobby** (or better): trial/free can restrict outbound APIs.
- **Serverless / app sleeping: OFF.** Long polling and cron die if the container sleeps.
- **Do not** generate a public domain. Nothing listens on HTTP.
- **Do not** enable an HTTP healthcheck on `$PORT` unless you also add a listener.
- **Replicas: 1.** Two instances = two pollers.

**Logs:** Railway deploy logs should show the five `Scheduled <job>:` registration lines with the active timezone followed by `Telegram long polling started.` Set `DEBUG=true` only when diagnosing nudge skips (`[nudge]`) or reminder skips (`[reminder]`).

**Redeploys:** Railway sends `SIGTERM`, which the process handles by stopping the poll loop and cron, finishing the message in hand and any running job (tracked in `inFlightJobs`), and exiting 0. Because the `getUpdates` offset is only advanced as updates are handled, an update interrupted by a deploy is redelivered rather than lost.

**Local run (dev only):**

```bash
# .env present, production poller stopped
npm ci
npm start
```

## Conventions for future changes

- Do not log secrets, tokens, or full `.env`.
- When changing nudge or reminder product rules, update **both** `server.js` and this file in the same change.
- Run `npm test` after any change. After behavior changes, also verify: one poller, listing tasks via natural language still works, 05:00 rollover status transitions, nudge gates still deterministic, a one-off reminder fires exactly once, and a recurring reminder advances by wall clock.
- Treat network round trips as the thing to minimize; nothing here is CPU-bound. Batch Supabase writes, do not re-read rows the caller will not use, and never re-fetch a list just to return it up the stack.

## Out of scope (unless product explicitly changes)

- Webhook mode for Telegram (would need a public HTTPS URL and a rewrite of the poller). Long polling is the current low-ops path.
- Local Postgres; source of truth is hosted Supabase.
- GPIO / Raspberry Pi–specific code. Hardware is not part of production.
- Marketing site, admin dashboard, or a second client besides Telegram.
- Linking a reminder to a task row. Reminders are standalone by design; a `task_id` column would drag task status into the firing path.
