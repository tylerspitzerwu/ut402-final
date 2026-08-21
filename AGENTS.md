# Agent source of truth

This file is the technical and operational source of truth for this repository. Read it before changing behavior, adding features, or touching deployment. Prefer this document over chat history.

Product reminder rules that are implemented in code (caps, calendar gaps, Claude phrasing vs deterministic scheduling) are described here. There is no separate product-rules file in the repo; keep this document in sync when those rules change.

## Who this is for

**One person:** Tyler. This is a **personal productivity** system, not a multi-user product, SaaS, or team tool. There is no signup, no accounts besides the env-configured Telegram bot and a single `TELEGRAM_CHAT_ID` for scheduled messages.

**What “good” means:** seamlessness, **low latency**, **low friction**, and **convenience**. The owner should capture, complete, push, or check tasks in Telegram with as little ceremony as possible—natural language, fast replies, no extra apps, no confirmation mazes, no dashboards to log into.

When choosing among implementations, prefer:

- Fast round-trips (keep Claude calls small; avoid extra model round-trips for one user message).
- Always-on production (Railway, sleeping off) so morning/night jobs and polling just happen.
- Defaults that do the obvious thing rather than asking the user to configure.

Do **not** optimize for multi-tenancy, enterprise auth, admin consoles, or “scale to many users.” Extra abstraction for hypothetical other users is friction.

## What this project is

A personal **Telegram task assistant** plus **scheduled messages** (smart reminders, morning briefing, nightly digest, daily rollover).

It is a **single long-running Node.js process** (`server.js`). It does **not** serve HTTP. It does **not** expose a public URL. Incoming messages arrive by **Telegram long polling** (`getUpdates`). Outbound work is HTTPS to Telegram, Anthropic, Google OAuth/Calendar, and Supabase.

The assistant persona in Claude prompts is named **Tod**.

## Runtime shape

```
Tyler (Telegram)  --getUpdates (long poll)-->  Node process (server.js)
                                                    |
                    node-cron (in-process, America/Los_Angeles)
                                                    |
         +------------------+------------------+----+------------------+
         |                  |                  |                       |
    Anthropic API      Google Calendar     Telegram sendMessage     Supabase
    (task ops JSON     (busy intervals)    (replies + scheduled)    (tasks, reminders)
     + reminder/morning copy)
```

- **Entry:** `npm start` → `node server.js` (`package.json`).
- **Module type:** CommonJS (`"type": "commonjs"`).
- **Node:** 20+ required by `@supabase/supabase-js`; production uses Node 22 on Railway.
- **Secrets:** `dotenv` loads `.env` locally. Production injects the same names as environment variables. `.env` is gitignored; never commit it or paste secret values into docs, commits, or chat.

On boot the process:

1. Creates a Supabase client (fails fast if URL/key missing).
2. Registers four `node-cron` jobs (timezone `America/Los_Angeles`).
3. Starts the Telegram polling loop (fails fast if `TELEGRAM_BOT_TOKEN` is missing).

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

All names are read in `server.js`. Production (Railway **Variables** tab) must define the same set. Locally they live in `.env`.

| Name | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes (startup) | Bot API token; long poll + `sendMessage` |
| `TELEGRAM_CHAT_ID` | yes (scheduled sends) | Destination for reminders, morning, nightly digest |
| `ANTHROPIC_API_KEY` | yes (task NL + copy) | Claude Messages API |
| `CLAUDE_MODEL` | no | Default `claude-haiku-4-5-20251001` |
| `SUPABASE_URL` | yes (startup) | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (startup) | Server-side access; bypasses RLS. Treat as a secret. |
| `GOOGLE_CLIENT_ID` | yes (reminders) | OAuth client for Calendar |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth secret |
| `GOOGLE_REFRESH_TOKEN` | yes | Offline token → access token |
| `GOOGLE_CALENDAR_IDS` | yes | Comma-separated calendar IDs (e.g. `primary,user@gmail.com`) |
| `DEBUG` | no | `true` enables extra reminder-tick logs and debug payloads on some errors. Production should be `false`. |
| `NODE_ENV` | no | Set `production` on Railway |

Telegram user **commands** (`/list`, `/help`, natural language) are handled for **any chat** that messages the bot. **Scheduled** messages always go to `TELEGRAM_CHAT_ID`, not necessarily the last chatter.

## Data: Supabase

Two tables. The service role key is used from this process only.

### `tasks`

Columns used in code: `id` (UUID), `title`, `urgency` (1–10), `duration` (minutes), `status`, `created_at`, `updated_at`.

**Status machine**

| Status | Meaning |
| --- | --- |
| `open` | Active to-do. Listed, editable, eligible for reminders/morning. |
| `completed` | User finished it. Hidden from open lists. Deleted at 05:00 PT rollover. |
| `canceled` | User abandoned it (`delete` op or `/clear`). Deleted at rollover. |
| `pushed` | Deferred to tomorrow. Reopened to `open` at 05:00 PT rollover. |

Claude may only target **open** rows for update/delete/complete/push. Create always inserts `status: "open"`. Defaults if Claude omits numbers: urgency `5`, duration `30`, title `"Untitled Task"`.

### `reminders`

Used to persist **smart reminder** sends so caps survive restarts.

Columns used: `id`, `created_at`, `task_ids` (array of task UUIDs suggested in that send). Inserts do not set `created_at` in application code (DB default).

Daily cap counts rows with `created_at >=` the current reminder-day start (05:00 PT). Cooldown uses the most recent row’s `created_at`. Rollover **deletes all reminder rows**.

## Telegram interaction

Polling: `getUpdates` with `timeout=50`, offset advanced per `update_id`. Only `message.text` is handled (no photos, callbacks, etc.). On HTTP/API failure the loop waits 3s and retries.

**Commands** (exact `/list`, `/help`, `/start`, `/clear`, also prefixes like `/list `):

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Static help text |
| `/list` | Open tasks with title, urgency, duration, truncated id (not Claude) |
| `/clear` | Sets all **open** tasks to `canceled` |

Any other text goes to `processTaskQuery`: Claude returns JSON operations; this process applies them to Supabase, then sends Claude’s user-facing `message` (or a fallback summary).

**Operations Claude may emit:** `create` | `update` | `delete` | `complete` | `push`.

- `delete` → status `canceled` (not a SQL DELETE).
- `complete` → `completed`.
- `push` → `pushed` (comes back at 05:00 PT).

Claude is instructed: JSON only; friendly `message` without IDs/urgency/duration; multi-task replies use `- ` bullets.

Replies longer than 4096 characters are split (`splitTelegramText`).

## Scheduled jobs (`node-cron`, `America/Los_Angeles`)

Do not switch these to UTC cron without changing the timezone option. Function names like `isWithinEtSendWindow` / `getReminderDayStartEtUtc` are **historical**; windows are **Pacific**.

| Cron | PT wall clock | Function | Behavior |
| --- | --- | --- | --- |
| `0 5 * * *` | 05:00 | `runDailyRollover` | `pushed` → `open`; **delete** `completed` and `canceled`; **delete all** `reminders` |
| `30 5 * * *` | 05:30 | `runMorningMessage` | Claude morning copy from **open** tasks (fallback if Claude fails); send to `TELEGRAM_CHAT_ID` |
| `*/10 * * * *` | every 10 min | `runSmartReminderTick` | Smart reminder (see below) |
| `0 22 * * *` | 22:00 | `runNightlyDigest` | Deterministic recap: completed / canceled / still open; **not** Claude |

If a job throws, it is logged; the process stays up.

## Smart reminders (deterministic gates, Claude phrasing)

Implemented in `runSmartReminderTick` / `canSendReminderNow`. Product intent: remind only during real free time, about work that **fits the current gap**.

**Eligibility (all must pass), in order:**

1. Wall clock in PT is between **12:00 and 22:00** inclusive (`isWithinEtSendWindow`).
2. Fewer than **3** reminder rows since **05:00 PT** today (`getReminderDayStartEtUtc`).
3. At least **120 minutes** since the latest reminder `created_at` (any day; uses most recent row).
4. Google Calendar: current time is **not** inside a busy interval.
5. Remaining free gap until next busy block (or 36-hour fetch horizon) is **≥ 30 minutes** (`MIN_FREE_GAP_MINUTES_FOR_REMINDER`).
6. At least one **open** task with `duration` ≤ remaining gap minutes.

Then pick up to **3** eligible tasks, highest `urgency` first (`pickTopTasksThatFit`). Claude writes 1–3 suggestive sentences. On Claude failure, a template fallback is sent. After a successful Telegram send, insert a `reminders` row (even if persist fails, the user already got the message — next tick may double-send if insert failed).

**Calendar “busy” rules** (`parseGoogleEventBusyInterval`):

- Timed events with `start.dateTime` / `end.dateTime` only.
- Ignore **all-day** (`start.date` / `end.date`).
- Ignore **cancelled** events.
- Ignore events where the **self** attendee `responseStatus` is `declined`.
- Fetch each ID in `GOOGLE_CALENDAR_IDS`, merge overlapping intervals.
- Horizon: now + **36 hours**.

OAuth: refresh token → `https://oauth2.googleapis.com/token`, then Calendar Events list API.

## Claude usage (three call sites)

| Call | Role | Must not do |
| --- | --- | --- |
| `processTaskQuery` | Parse NL → JSON ops + user `message`; temperature 0.2, max_tokens 800 | Apply DB writes (the Node loop does that) |
| `generateReminderCopy` | Phrase a reminder; temperature 0.4, max_tokens 200 | Decide whether to send, caps, or calendar math |
| `generateMorningCopy` | Phrase morning briefing; temperature 0.6, max_tokens 220 | Same |

Keep **scheduling, caps, gap math, and persistence in deterministic code**. Do not move those decisions into Claude.

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

**Logs:** Railway deploy logs should show Telegram polling started and the four cron registration lines. Set `DEBUG=true` only when diagnosing reminder skips (`[smartreminder]`).

**Local run (dev only):**

```bash
# .env present, production poller stopped
npm ci
npm start
```

## Conventions for future changes

- Keep the app a **single Node file** unless a split is clearly justified; if you split, update this document.
- Timezone for user-facing schedules is **`America/Los_Angeles`** (PST/PDT). Do not reintroduce Eastern Time.
- Do not add Trigger.dev, GitHub Actions cron, or a second process for reminders.
- Do not log secrets, tokens, or full `.env`.
- Prefer fixing Railway by config (sleeping, healthcheck, replica count) over adding HTTP, unless the platform requires a bind.
- When changing reminder product rules, update **both** `server.js` and this file in the same change.
- After behavior changes, verify: one poller, `/list` still works, 05:00 rollover status transitions, reminder gates still deterministic.
- Optimize for **the single owner’s convenience**: fewer steps, faster replies, stay in Telegram. Do not add auth, onboarding, settings screens, or “are you sure?” flows for routine task ops unless there is a real data-loss risk (`/clear` is the main bulk-destructive command).
- Prefer one Claude call per user message over multi-step agent loops.
- Reliability of always-on scheduling beats extra features that make the bot slower or require opening another app.

## Out of scope (unless product explicitly changes)

- Webhook mode for Telegram (would need a public HTTPS URL and a rewrite of the poller). Long polling is the current low-ops path.
- Multi-user tenancy, teams, or per-user accounts (scheduled chat ID is a single env var; commands currently accept any chat that knows the bot).
- Local Postgres; source of truth is hosted Supabase.
- GPIO / Raspberry Pi–specific code. Hardware is not part of production.
- Marketing site, admin dashboard, or a second client besides Telegram.
