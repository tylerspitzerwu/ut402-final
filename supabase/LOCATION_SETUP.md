# Set up the location-upload endpoint

This deploys an independent Supabase Edge Function. The Railway bot stays on
Telegram long polling. Uploads do not send Telegram messages or call Claude.
The bot consumes this location only when `LOCATION_AWARE_NUDGES=true` is enabled
in Railway, after the existing nudge eligibility checks. It uses Google Nearby
Search and a short coordinate trail as evidence for one Claude decision.

**Already uploading successfully?** Run only the new
`migrations/20261027000000_location_trail.sql` in your existing project's SQL
Editor, then follow section 5. Your existing deployed Edge Function, token,
Shortcut fields, and upload URL remain valid. No phone changes or Edge Function
redeployment are required for coordinate trails.

## 1. Create the table and database function

Open the **same Supabase project Tod already uses**. In **SQL Editor → New query**,
paste the complete contents of `migrations/20261026000000_owner_location.sql` and
run it once. Then run `migrations/20261027000000_location_trail.sql` once. The
first migration creates `owner_location`, enables Row Level Security, restricts
access to the server role, and creates an atomic timestamp-guarded write function.
The second adds a JSON trail to the same row and updates that function to retain
the latest three reports. There are no public or signed-in-user access policies.

## 2. Generate a phone-only upload token

Run this in your own terminal:

```sh
openssl rand -hex 32
```

Keep the result in your password manager. Use that same value in the function's
secret and in Shortcuts. It is not your Supabase service-role key.

In **Edge Functions → Secrets**, add:

```text
LOCATION_UPLOAD_TOKEN = your generated token
```

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to hosted Edge
Functions. These remain server-side; the phone only gets the upload token.
No new Railway variable is needed for this upload endpoint.

## 3. Deploy the Edge Function

In **Edge Functions → Deploy a new function → Via Editor**:

1. Name the function **location-update**.
2. Replace the starter **index.ts** contents with the complete contents of
   `functions/location-update/index.mjs`. The source uses JavaScript syntax that
   the TypeScript entrypoint also accepts; the exported test helper is intentional.
   The `.mjs` entrypoint in this repo is used for CLI deployment and Node tests.
3. Deploy the function.
4. In its details/configuration, turn **Verify JWT** (sometimes labeled
   **Enforce JWT Verification**) **off**. The dedicated Bearer token is not a
   Supabase login JWT. The function checks that token itself before reading data.

Copy the function's invoke URL from the dashboard. Its usual shape is:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/location-update
```

Alternatively, with the Supabase CLI installed and logged in, deploy from the
repository root after the SQL and secret have been configured:

```sh
supabase functions deploy location-update --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

The checked-in `config.toml` sets the JavaScript entrypoint and JWT configuration.

## 4. Connect the iPhone Shortcut

In **Get Contents of URL**, use the copied invoke URL, method **POST**, and:

| Header | Value |
| --- | --- |
| Authorization | `Bearer YOUR_UPLOAD_TOKEN` |
| Content-Type | `application/json` |

Set **Request Body → JSON**:

| Key | Type | Value |
| --- | --- | --- |
| latitude | Number | Latitude variable |
| longitude | Number | Longitude variable |
| reported_at | Text | Current date formatted as ISO 8601, including time and timezone |

Run the Shortcut manually. For the first test only, append **Show Result** after
the upload action. A successful new upload returns:

```json
{"ok":true,"saved":true}
```

Open **Table Editor → owner_location** and verify one row with the new timestamp.
Run it again and verify that the same row is updated and its `trail` now contains
two reports. Remove **Show Result** before
enabling scheduled runs, then test one scheduled run while the phone is locked.

An upload with the same or older `reported_at` returns `{"ok":true,"saved":false}`
and preserves the newer stored position and trail. Accepted uploads append to the
trail atomically, retain at most three chronological reports, and prune entries
more than 30 minutes before the new report. Old trail entries remain stored until
a subsequent upload prunes/replaces them; there is no separate cleanup timer.
Uploads older than 24 hours or more than
five minutes in the future are rejected. `reported_at` is the phone's report time,
not a guarantee that iOS obtained a new GPS fix at that exact instant. Future
location-based decisions also need to account for freshness and location uncertainty.

## Troubleshooting

- **401:** match the token exactly (one space after `Bearer`) and turn off the
  platform JWT check for this function. The endpoint still enforces its own token.
- **400:** coordinates must be JSON numbers, and the date must include seconds
  and an explicit timezone. Use Shortcuts' ISO 8601 format with time included.
- **415:** select JSON body and the `application/json` content type.
- **503:** verify the secret exists and is at least 32 characters, run the SQL,
  and check the function logs. Responses never include database error details.

## 5. Enable location-aware nudges

1. Verify scheduled uploads continue while your phone is locked. The bot accepts
   positions only when both report and receipt timestamps are within 20 minutes.
2. In Google Cloud, enable **Places API (New)** in a billing-enabled project.
   Create a dedicated API key restricted to that API, and store it in Railway as
   `GOOGLE_MAPS_API_KEY`. This key stays on the server; it is separate from the
   phone upload token and Calendar OAuth credentials. Nearby Search requests use
   Pro fields only. Anthropic web search and Maps Grounding Lite are not used.
3. Deploy the updated `server.js` to Railway through the normal GitHub deployment.
4. In Railway Variables set `LOCATION_AWARE_NUDGES=true`. A restart/redeploy loads
   it; the default is `false` until enabled. Keep the service at one replica.
5. For diagnosis, temporarily set `DEBUG=true` and inspect `[nudge]` logs. The
   server logs skip reasons without coordinates or source results. Do not start
   a second local poller to test production.

Each ten-minute tick runs the existing checks first. Only an eligible tick reads
location and its trail, then calls Google Nearby Search once (up to ten places
within 150 meters, distance-ranked). It gives Claude those place candidates, raw
reports and movement measurements, selected tasks, and calendar context. One
Claude request both decides and writes a suggestion if appropriate. There is no
minimum dwell time, sample-count requirement, or hard movement/uncertainty gate;
Claude weighs the evidence as requested. One fresh report is enough to assess.

Movement measurements include observation span, maximum separation, net movement,
sampled path, and interval-average straight-line displacement rates. They are not
current speed or proof of an activity. Buildings and businesses nearby do not
establish occupancy. Empty successful place results mean unknown setting and are
still given to Claude. Missing/stale current location, API failure, or malformed
assessment skips the tick without a template fallback. There are no preliminary
Telegram notifications and no map data is displayed in the final suggestion.

Only phone reports are persisted. Nearby place names/categories/coordinates and
the raw assessment remain in memory for the current tick. No building footprints,
Driving Focus, road matching, or phone motion sensors are included in this version.

### View the decisions

Open your **Railway project → bot service → latest deployment → logs** and search
for **`[nudge-decision]`**. These structured JSON entries are always enabled when
`LOCATION_AWARE_NUDGES=true`, including with `DEBUG=false`.

- `skipped`: a fixed reason explains why the tick stopped, such as
  `outside_send_window`, `cooldown`, `calendar_busy`, or
  `location_unavailable_or_stale`. These can occur before any Claude request.
- `assessment`: Claude's send/skip choice, confidence, reason, and a short
  explanation of its main basis. Counts of selected tasks, reports, nearby
  candidates, and available minutes give context. This is a brief decision
  summary, not step-by-step reasoning.
- `sent`: Telegram accepted the suggestion. An approved assessment can instead
  be followed by `skipped` (`eligibility_changed_after_assessment`) or
  `delivery_failed`. `send_log_failed` means delivery succeeded but recording it
  for the daily cap failed.

Entries from the same tick share `tick_id`; `at` is UTC and `time_zone` identifies
the bot's active timezone. For example, an assessment might include:

```json
{"event":"assessment","send":false,"reason":"uncertain","confidence":"medium","explanation":"Ambiguous surroundings make a work suggestion poorly timed."}
```

The logger does not copy raw coordinates, place results, task titles, suggestion
text, or upstream errors. Claude is instructed to omit identifying details from
the explanation; its type and length are validated, but semantic redaction is
not enforced. Logs remain subject to Railway's retention. No database migration,
additional environment setting, extra model request, or Telegram notification is
needed for logging. Entries begin after deploying this code; previous decisions
cannot be reconstructed.

Explicit timed reminders still fire as requested. Morning and nightly messages
also keep their existing behavior. To restore ordinary nudges, set
`LOCATION_AWARE_NUDGES=false` and restart/redeploy.

The application stores one row containing the current position and at most three
recent reports, not a full location history. This is not a guarantee about
Supabase database backups or platform-level request logging.

Official references: [Dashboard deployment](https://supabase.com/docs/guides/functions/quickstart-dashboard),
[secrets](https://supabase.com/docs/guides/functions/secrets),
[JWT configuration](https://supabase.com/docs/guides/functions/function-configuration),
[Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search),
[Google API key setup](https://developers.google.com/maps/documentation/places/web-service/get-api-key).
