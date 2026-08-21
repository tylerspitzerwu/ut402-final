# Agent source of truth

This file is the technical and operational source of truth for this repository. Read it before changing behavior, adding features, or touching deployment. Prefer this document over chat history.

Product rules that are implemented in code (nudge caps, calendar gaps, reminder time resolution and recurrence, Claude phrasing vs deterministic scheduling) are described here. There is no separate product-rules file in the repo; keep this document in sync when those rules change.

## Who this is for

**One person:** Tyler. This is a **personal productivity** system, not a multi-user product, SaaS, or team tool. There is no signup, no accounts besides the env-configured Telegram bot and a single `TELEGRAM_CHAT_ID` for scheduled messages.

**What “good” means:** seamlessness, **low latency**, **low friction**, and **convenience**. The owner should capture, complete, push, or check tasks in Telegram with as little ceremony as possible—natural language, fast replies, no extra apps, no confirmation mazes, no dashboards to log into.

When choosing among implementations, prefer:

- Fast round-trips (keep Claude calls small; avoid extra model round-trips for one user message).
- Always-on production (Railway, sleeping off) so morning/night jobs and polling just happen.
- Defaults that do the obvious thing rather than asking the user to configure.

Do **not** optimize for multi-tenancy, enterprise auth, admin consoles, or “scale to many users.” Extra abstraction for hypothetical other users is friction.

## What this project is

A personal **Telegram task assistant** plus **scheduled messages** (nudges, morning briefing, nightly digest, daily rollover) and **natural-language reminders** (“remind me at 2pm to call my dad”, “every weekday at 8am”).

It is a **single long-running Node.js process** (`server.js`). It does **not** serve HTTP. It does **not** expose a public URL. Incoming messages arrive by **Telegram long polling** (`getUpdates`). Outbound work is HTTPS to Telegram, Anthropic, Google OAuth/Calendar, and Supabase.

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
     on-demand history)                            copy)                   reminders,
                                                                           settings, history)
```

- **Entry:** `npm start` → `node server.js` (`package.json`).
- **Module type:** CommonJS (`"type": "commonjs"`).
- **Node:** pinned to `>=22` via `engines` in `package.json`, so Nixpacks does not silently pick a different major.
- **Secrets:** `dotenv` loads `.env` locally. Production injects the same names as environment variables. `.env` is gitignored; never commit it or paste secret values into docs, commits, or chat.

On boot the process:

1. Builds and freezes `config`, validating **every** required environment variable (fails fast on any missing name).
2. Creates a Supabase client.
3. Loads allowlisted runtime settings from Supabase; a read error or invalid stored value fails startup rather than scheduling in the wrong timezone.
4. Reclaims any reminder left in `sending` by a crash back to `pending` (`reclaimStuckReminders`). A failure here is logged, not fatal.
5. Registers five `node-cron` jobs in the active timezone, each wrapped in a single-flight guard.
6. Installs `SIGTERM` / `SIGINT` handlers that stop cron and polling, let the message currently being handled finish, then exit 0.
7. Starts the Telegram polling loop.

**Every outbound request has a timeout** (`fetchWithTimeout` + `TIMEOUT_MS`): Anthropic 20s, Google 10s, Telegram 10s, and 55s for the long poll, which needs headroom over its own `timeout=50`. This matters more than it looks: handling is serial and single-threaded, so one hung request without a timeout stalls the entire bot for as long as it hangs. Any new call site must go through `fetchWithTimeout`.

There is **no** Express/HTTP listener and **no** `PORT` bind. Do not add a web server unless a host requires a healthcheck. Do not use Trigger.dev or any external scheduler; scheduling stays in this process.

## Hard constraint: one poller

Telegram delivers `getUpdates` to **one** polling client per bot token. Running this process twice (laptop + Railway, two Railway replicas, local + Pi) causes missed or “stolen” updates.

When developing locally, **stop the Railway service** (or whatever is production). When production is live, do not leave `node server.js` running on a laptop.

## Repository layout

| Path | Role |
| --- | --- |
| `server.js` | Entire application: Telegram, Claude, Calendar, cron, Supabase |
| `package.json` / `package-lock.json` | Dependencies and `start` script |
| `.gitignore` | Ignores `.env`, `node_modules`, logs |
| `AGENTS.md` | This file |

There is no frontend, no tests suite, no Dockerfile, no `railway.toml`. Railway Nixpacks detects Node from `package.json`.

## Environment variables

Application configuration names are read in `server.js`. Production (Railway **Variables** tab) must define the same set. Locally they live in `.env`; `NODE_ENV` is Railway platform metadata rather than application configuration.

`buildConfig()` reads and validates **every required variable at boot** and freezes the result, so a missing credential crashes the process immediately instead of surfacing at 05:30 or midday. Nothing re-reads `process.env` at request time.

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes (startup) | Bot API token; long poll + `sendMessage` |
| `TELEGRAM_CHAT_ID` | yes (startup) | Owner chat (`config.ownerChatId`): destination for nudges, morning, nightly digest, and the only chat allowed to change settings or use history |
| `ANTHROPIC_API_KEY` | yes (startup) | Claude Messages API |
| `CLAUDE_MODEL` | no | Default `claude-haiku-4-5-20251001` |
| `SUPABASE_URL` | yes (startup) | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (startup) | Server-side access; bypasses RLS. Treat as a secret. |
| `GOOGLE_CLIENT_ID` | yes (startup) | OAuth client for Calendar |
| `GOOGLE_CLIENT_SECRET` | yes (startup) | OAuth secret |
| `GOOGLE_REFRESH_TOKEN` | yes (startup) | Offline token → access token |
| `GOOGLE_CALENDAR_IDS` | yes (startup) | Comma-separated calendar IDs (e.g. `primary,user@gmail.com`) |
| `DEBUG` | no | `true` enables extra nudge-tick and reminder-tick logs. Production should be `false`. |
| `NODE_ENV` | no | Platform-only; set `production` on Railway. `server.js` does not read it. |

Every incoming Telegram text message is handled as **natural language** for **any chat** that messages the bot. There are no slash-command shortcuts. **Scheduled** messages always go to `TELEGRAM_CHAT_ID`, not necessarily the last chatter.

## Data: Supabase

Five tables. The service role key is used from this process only. The `CREATE TABLE` / index SQL below is the hosted schema; keep it in sync when the tables change.

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

For every natural-language user query, Claude receives one read-only snapshot of all currently retained statuses with `created_at` and `updated_at`, ordered newest first. `created_at` answers when a task was added; for a currently completed, canceled, or pushed row, `updated_at` marks when that status was applied because non-open rows cannot be changed again before rollover. “Today” for task-date questions starts at the active timezone’s **05:00 rollover**, not midnight. Completed and canceled rows remain available for these answers only until the next rollover deletes them.

Claude may only target **open** rows for update/delete/complete/push, even though closed and pushed rows are visible as read-only context. The `.eq("status", "open")` database guards remain authoritative. Create always inserts `status: "open"`. Defaults if Claude omits numbers: urgency `5`, duration `30`, title `"Untitled Task"`.

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

Daily cap counts rows with `created_at >=` the current 05:00 local day start (`getLocalDayStartUtc`). Cooldown uses the most recent row’s `created_at`. Rollover **deletes all `nudges` rows**.

Both gates are answered by a **single** query for rows since that day start (`listNudgeSendsSince`). Restricting the cooldown check to today is safe because the local send window opens at 12:00, so any nudge from a previous day is already hours past the 120-minute cooldown. The rollover delete filters on `.not("id", "is", null)` rather than comparing `id` to a number, so it works whether `id` is a bigint or a UUID.

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
| `failed` | Telegram send failed `REMINDER_MAX_SEND_ATTEMPTS` (3) times, or stored recurrence is invalid. |
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

Only `pending` rows may be mutated. Every write goes through `markReminder` / `updatePendingReminder`, which carry `.eq("status", "pending")` for the same reason task writes carry `.eq("status", "open")`: it is what stops a canceled or already-fired reminder from being revived. A batched cancel detects stale or invented ids by diffing the returned `id` set against the requested one.

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

The first supported key is `timezone`, stored as a canonical IANA identifier such as `America/Los_Angeles` or `America/New_York`. If its row is absent, the code defaults to `America/Los_Angeles`. `TIME_ZONE_ALIASES` is a Node-side fallback for common US names and abbreviations even though the Claude prompt asks for canonical IANA names. Unknown rows are ignored; invalid values for known settings fail startup.

Credentials remain in frozen environment-backed `config`; preferences live in a separate mutable in-memory settings object loaded from this table. A setting change is normalized and validated, upserted first, and only then applied in memory. Adding a future natural-language preference requires an explicit entry in the settings registry with validation and any apply side effect—Claude cannot invent keys or arbitrary behavior.

### `chat_messages`

Stores the configured owner chat’s user-visible conversation for on-demand Claude retrieval. Columns used in code: `id` (UUID), `turn_id` (UUID), `chat_id` (text), `telegram_message_id` (nullable bigint), `role` (`user` or `assistant`), `kind`, `content`, `created_at`, plus the generated `search_vector` used by PostgreSQL full-text search.

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

Scheduled messages are stored as assistant-only turns with `kind` equal to `nudge`, `morning`, `digest`, or `reminder`. History writes and searches are owner-only: chats other than `TELEGRAM_CHAT_ID` continue to work but are neither stored nor given access to conversation history. A fired reminder for a non-owner chat is delivered but not stored, because `persistScheduledChatMessage` always writes as the owner.

The `search_chat_history(p_chat_id, p_query, p_since, p_before)` RPC returns matching turns ordered by relevance and recency. Claude’s tool exposes two modes: `recent` for an unresolved omitted object/action/antecedent, defaulting to the previous 30 minutes with no keyword filter; and `search` for an explicit topic or time-range lookup, defaulting to the rolling seven days. It has **no result-count limit**; Node pages through PostgREST responses until every matching row has been loaded, then re-filters every row to the allowed interval so companion rows outside the seven-day boundary cannot leak through. Both Node and the RPC clamp access to seven days, and the 05:00 rollover physically deletes older rows.

**Source-control gap:** the exact hosted SQL definition of `search_chat_history` is not present in this repository. The owner must export it from Supabase before this schema can be recreated from source; do not invent a replacement because ranking or boundary differences could change behavior.

## Telegram interaction

Polling: `getUpdates` with `timeout=50`, `limit=10`, `allowed_updates=["message"]`, offset advanced per `update_id`. Only `message.text` is handled (no photos, callbacks, etc.). On HTTP/API failure the loop waits 3s and retries.

Handling is **strictly serial**: the loop finishes one message (Claude call included) before fetching the next batch, which keeps replies in order. Do not make this concurrent without a reason; the stall risk it used to carry is handled by request timeouts instead.

Every non-empty text message goes to `processUserQuery`. There are no `/list`, `/settings`, `/help`, `/start`, or `/clear` handlers: listing tasks, reading settings, help, Telegram’s automatic `/start`, and canceling every open task are ordinary Claude requests. Claude must finish through the structured `submit_operations` tool, whose input contains task/settings operations and a user-facing `message`. This process validates and applies the operations to Supabase, then sends the response. Task prose comes from Claude (or a fallback); setting confirmations come from deterministic apply results so the bot cannot claim a failed setting write succeeded. Cancel-all is one `delete` per currently open task, batched by `applyTaskOperations`.

For the owner chat, the first `processUserQuery` Claude request exposes both `search_chat_history` and `submit_operations` but sends no past conversation. Tool choice is mandatory and parallel use is disabled: Claude either finishes immediately through `submit_operations` or performs one warranted history lookup. After a lookup, the second request exposes and forces only `submit_operations`, so another search is impossible. Non-owner chats receive only the forced submit tool.

History is mandatory when an omitted object, action, or antecedent cannot be uniquely resolved from the current message and task snapshot. It is not used for standalone requests or task-date questions answerable from structured task timestamps. The server, not Claude, supplies the owner chat ID and clamps requested timestamps. Retrieved messages are context only: old requests do not authorize new task operations. If several antecedents remain plausible, Claude submits no operation and asks for clarification.

**Operations Claude may emit:** `create` | `update` | `delete` | `complete` | `push` | `set_setting` | `create_reminder` | `update_reminder` | `cancel_reminder`.

- `delete` → status `canceled` (not a SQL DELETE).
- `complete` → `completed`.
- `push` → `pushed` (comes back at 05:00 in the active timezone).
- `set_setting` → validates and upserts one allowlisted `bot_settings` key. Only messages from the configured `TELEGRAM_CHAT_ID` may mutate global settings.
- `create_reminder` → inserts a `pending` row in `scheduled_reminders`, delivered back to the chat that asked.
- `update_reminder` / `cancel_reminder` → target one `pending` row by `reminderId`. Canceling a repeating reminder cancels the whole series; there is no per-occurrence skip.

`applyTaskOperations` batches these to keep the reply fast: **one** insert for all creates, **one** update per destination status (`.in("id", ids).eq("status", "open")`), and one update per distinct field payload for `update` ops. Updates run before status transitions so “rename X and mark it done” applies both. Since batched writes cannot use `.single()`, a stale or invented `targetId` is detected by diffing the returned `id` set against the requested one, not by a zero-row error. Keep the `.eq("status", "open")` guard on every write: it is what stops Claude from reviving a closed task.

Unknown operation names are rejected rather than coerced into task creation. The structured submission schema requires an operations array and a friendly task `message` without IDs/urgency/duration; multi-task replies use `- ` bullets; setting-only and reminder-only replies leave `message` empty because Node confirms the actual result. A **missing** `message` is tolerated rather than fatal: setting and reminder lines are written by Node anyway, and task replies fall back to a deterministic summary. Only a missing operations array is unrecoverable.

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

## Reminders (fully deterministic)

Implemented in `runReminderTick` / `fireOneOffReminder` / `fireRecurringReminder`. The tick selects `pending` rows with `next_due_at <= now()` and handles them serially. Delivery text is a plain `Reminder: <body>` and the body was finalized when the reminder was created, so **no Claude call happens at fire time**: no latency and no failure mode at 2pm.

**Reminders deliberately bypass every nudge gate.** No 12:00–22:00 window, no daily cap, no cooldown, no calendar-busy suppression, and they do not count toward the nudge cap. The user asked for this message at this time; second-guessing it is exactly the friction this project avoids. Do not "unify" the reminder and nudge send paths.

**Delivery is once-only, by claiming before sending.** A one-off is first moved `pending → sending` with the status guard; if the guard matches nothing (canceled in the meantime) the tick skips it. Only then is Telegram called. This is deliberately *not* the `nudges` table's send-then-record pattern, which accepts a double-send. A send failure increments `attempts` and returns the row to `pending`; at 3 attempts it becomes `failed`. A crash between claiming and sending leaves the row in `sending`, and `reclaimStuckReminders` returns it to `pending` at boot — which can duplicate a message if the crash landed after Telegram accepted it, the accepted cost of never silently dropping one.

**A series advances before it sends.** `fireRecurringReminder` writes the next occurrence (or `exhausted`) *first*, then delivers. A crash therefore costs one message instead of leaving a row that re-fires every minute. Because the row jumps straight to the next occurrence strictly after `now`, an outage spanning many missed occurrences delivers **one** message, not a burst — a three-day gap in a daily 8am reminder does not produce three sends. A late one-off, by contrast, always fires whenever the process comes back.

**Recurrence is expanded in wall-clock terms, never by adding milliseconds.** `computeNextOccurrence` walks candidate local dates and resolves each through `resolveZonedWallClock`. Adding 86 400 000 ms to the previous instant would silently shift “every day at 8am” by an hour at each DST transition. Three edges are handled explicitly:

- **Spring forward:** a rule for 02:30 names a wall clock that does not exist that day. `makeDateInTimeZone` cannot converge, so the round trip is verified and `findFirstInstantAtOrAfterWallClock` binary-searches the first instant the clock actually reaches (03:00).
- **Fall back:** 01:30 happens twice. Requiring the next instant to be strictly greater than the previous one over distinct local dates yields exactly one fire.
- **Month end:** `byMonthDay: 31` clamps to the last day of a short month (February 28) rather than skipping that month. `interval > 1` phase is anchored to `created_at`, so “every other Monday” keeps its parity across recomputes.

**Timezone semantics differ by kind, on purpose.** A one-off reminder means an absolute instant and never moves when the timezone setting changes. A recurring reminder means a local wall clock, so `rescheduleRecurringReminders` recomputes every live series when the timezone changes and updates its `time_zone`. Recomputing from `now` also clamps forward: moving Eastern → Pacific shifts an 8am series backwards in absolute terms and would otherwise fire it immediately. If that recompute fails, the timezone change still succeeds and `fireRecurringReminder` self-heals — a row whose `time_zone` no longer matches the active zone is rezoned and skipped for that tick instead of firing at the old wall clock.

## Nudges (deterministic gates, Claude phrasing)

Implemented in `runNudgeTick` / `canSendNudgeNow`. Product intent: suggest work only during real free time, about tasks that **fit the current gap**. Telegram copy stays suggestive prose; do not call these “nudges” in the user-facing text.

**Eligibility (all must pass), in order:**

1. Wall clock in the active timezone is between **12:00 and 22:00** inclusive (`isWithinNudgeSendWindow`).
2. Fewer than **3** `nudges` rows since **05:00 local** today (`MAX_NUDGES_PER_DAY`, `getLocalDayStartUtc`).
3. At least **120 minutes** since the latest nudge send `created_at` (`NUDGE_COOLDOWN_MINUTES`; uses the most recent row since the 05:00 day start).
4. Google Calendar: current time is **not** inside a busy interval.
5. Remaining free gap until next busy block (or the fetch horizon) is **≥ 30 minutes** (`MIN_FREE_GAP_MINUTES_FOR_NUDGE`).
6. At least one **open** task with `duration` ≤ remaining gap minutes.

Then pick up to **3** eligible tasks, highest `urgency` first (`pickTopTasksThatFit`). Claude writes 1–3 suggestive sentences. On Claude failure, a template fallback is sent. After a successful Telegram send, insert a `nudges` row (even if persist fails, the user already got the message — next tick may double-send if insert failed).

**Calendar “busy” rules** (`parseGoogleEventBusyInterval`):

- Timed events with `start.dateTime` / `end.dateTime` only.
- Ignore **all-day** (`start.date` / `end.date`).
- Ignore **cancelled** events.
- Ignore events where the **self** attendee `responseStatus` is `declined`.
- Fetch every ID in `GOOGLE_CALENDAR_IDS` **in parallel**, following `nextPageToken`, then merge overlapping intervals.
- Horizon: now + **6 hours** (`CALENDAR_HORIZON_HOURS`).

The horizon is deliberately short. Every gate compares against 30 minutes or less, so a longer window cannot change any decision — it only inflated the “you have about N minutes free” number on an empty calendar. If you raise it, cap what the nudge copy advertises.

Requests send a `fields` mask (`CALENDAR_FIELDS_MASK`) covering only what `parseGoogleEventBusyInterval` reads, with `maxResults=250` per page. Widening the parser means widening the mask, or the new field will silently arrive as `undefined`.

OAuth: refresh token → `https://oauth2.googleapis.com/token`, then Calendar Events list API. The access token is **cached** in memory until 5 minutes before its `expires_in`, and dropped on a `401` so the next tick re-fetches.

## Claude usage (three call sites)

| Call | Role | Must not do |
| --- | --- | --- |
| `processUserQuery` | Parse NL → structured `submit_operations`; read all retained task statuses/timestamps and pending reminders; optionally retrieve owner chat history once; temperature 0.2, max_tokens 800 | Apply DB writes, validate settings, claim setting success, mutate closed tasks or non-pending reminders, convert timezones, state a reminder time, or retrieve history for standalone/task-date requests |
| `generateNudgeCopy` | Phrase a nudge; temperature 0.4, max_tokens 200 | Decide whether to send, caps, or calendar math |
| `generateMorningCopy` | Phrase morning briefing; temperature 0.6, max_tokens 220 | Same |

Keep **scheduling, caps, gap math, time-zone conversion, recurrence expansion, and persistence in deterministic code**. Do not move those decisions into Claude. Reminder delivery involves no Claude call at all.

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

**Redeploys:** Railway sends `SIGTERM`, which the process handles by stopping the poll loop, finishing the message in hand, and exiting 0. Because the `getUpdates` offset is only advanced as updates are handled, an update interrupted by a deploy is redelivered rather than lost.

**Local run (dev only):**

```bash
# .env present, production poller stopped
npm ci
npm start
```

## Conventions for future changes

- Do not log secrets, tokens, or full `.env`.
- When changing nudge or reminder product rules, update **both** `server.js` and this file in the same change.
- After behavior changes, verify: one poller, listing tasks via natural language still works, 05:00 rollover status transitions, nudge gates still deterministic, a one-off reminder fires exactly once, and a recurring reminder advances by wall clock.
- Treat network round trips as the thing to minimize; nothing here is CPU-bound. Batch Supabase writes, do not re-read rows the caller will not use, and never re-fetch a list just to return it up the stack.

## Out of scope (unless product explicitly changes)

- Webhook mode for Telegram (would need a public HTTPS URL and a rewrite of the poller). Long polling is the current low-ops path.
- Local Postgres; source of truth is hosted Supabase.
- GPIO / Raspberry Pi–specific code. Hardware is not part of production.
- Marketing site, admin dashboard, or a second client besides Telegram.
- Linking a reminder to a task row. Reminders are standalone by design; a `task_id` column would drag task status into the firing path.
