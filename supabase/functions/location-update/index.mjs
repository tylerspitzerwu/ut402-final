// Self-contained so this file can also be pasted into the Supabase Dashboard.
// It never calls Telegram or Claude, and never logs coordinates or tokens.
const MAX_BODY_BYTES = 4096;
const MAX_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

async function tokensMatch(actual, expected) {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([actual, expected].map(async (token) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)))
  ));
  let difference = 0;
  for (let i = 0; i < hashes[0].length; i++) difference |= hashes[0][i] ^ hashes[1][i];
  return difference === 0;
}

async function fetchWithTimeout(fetchImpl, url, options) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(10_000)
  });
  // Consume the body inside the timeout, too.
  const text = await response.text();
  return { ok: response.ok, text };
}

export function createLocationHandler({ getEnv, fetchImpl = fetch, now = Date.now }) {
  return async (request) => {
    if (request.method !== "POST") {
      const response = json(405, { error: "Use POST." });
      response.headers.set("Allow", "POST");
      return response;
    }

    const uploadToken = getEnv("LOCATION_UPLOAD_TOKEN");
    const supabaseUrl = getEnv("SUPABASE_URL");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!uploadToken || uploadToken.length < 32 || !supabaseUrl || !serviceKey) {
      return json(503, { error: "Location upload is not configured." });
    }
    const suppliedToken = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!suppliedToken || !(await tokensMatch(suppliedToken, uploadToken))) {
      return json(401, { error: "Unauthorized." });
    }
    if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "Use application/json." });
    }

    let body;
    try {
      // Bound actual bytes, even when Content-Length is absent or misleading.
      const reader = request.body?.getReader();
      if (!reader) return json(400, { error: "JSON body is required." });
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
          await reader.cancel();
          return json(413, { error: "Request body is too large." });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json(400, { error: "Invalid JSON." });
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.latitude !== "number" || !Number.isFinite(body.latitude) ||
        body.latitude < -90 || body.latitude > 90 ||
        typeof body.longitude !== "number" || !Number.isFinite(body.longitude) ||
        body.longitude < -180 || body.longitude > 180) {
      return json(400, { error: "latitude and longitude must be numbers in valid ranges." });
    }
    // Require an explicit zone; never interpret the phone's timestamp in the
    // server's timezone. Shortcuts' ISO 8601 format supplies this.
    const timestamp = typeof body.reported_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(body.reported_at)
      ? Date.parse(body.reported_at) : NaN;
    const currentTime = now();
    if (!Number.isFinite(timestamp) || timestamp < currentTime - MAX_REPORT_AGE_MS ||
        timestamp > currentTime + MAX_FUTURE_SKEW_MS) {
      return json(400, { error: "reported_at must be a recent ISO 8601 timestamp with a timezone." });
    }

    try {
      const result = await fetchWithTimeout(fetchImpl,
        `${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/record_owner_location`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            p_latitude: body.latitude,
            p_longitude: body.longitude,
            p_reported_at: new Date(timestamp).toISOString()
          })
        });
      if (!result.ok) throw new Error("Location persistence failed.");
      const saved = JSON.parse(result.text);
      if (typeof saved !== "boolean") throw new Error("Unexpected persistence response.");
      return json(200, { ok: true, saved });
    } catch {
      // Avoid logging request bodies, headers, or upstream response bodies.
      console.error("Location upload: database request failed.");
      return json(503, { error: "Could not save location. Try again later." });
    }
  };
}

// Importing under node:test has no network or listener side effects.
if (typeof Deno !== "undefined") {
  Deno.serve(createLocationHandler({ getEnv: (name) => Deno.env.get(name) }));
}
