const PROFILE_IDS = ["user-1", "user-2", "user-3"];

export function defaultSettings() {
  return {
    targets: { KO: null, PEP: null, JNJ: null, PG: null, CL: null },
    events: { watch: true, candidate: true, target: true, oversold: true, recovery: true },
    health_alerts: true,
    backtest: { fee_bps: 10, monthly_contribution: 1000 }
  };
}

export function validateSettings(settings) {
  const keysMatch = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
    && Object.keys(object).sort().join() === [...keys].sort().join();
  if (!keysMatch(settings, ["targets", "events", "health_alerts", "backtest"])) throw new Error("Seadistuse väljad ei sobi.");
  if (!keysMatch(settings.targets, ["KO", "PEP", "JNJ", "PG", "CL"])) throw new Error("Sihthindade nimekiri ei sobi.");
  for (const value of Object.values(settings.targets)) {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error("Sihthind peab olema positiivne arv.");
  }
  if (!keysMatch(settings.events, ["watch", "candidate", "target", "oversold", "recovery"])
      || Object.values(settings.events).some((value) => typeof value !== "boolean")
      || typeof settings.health_alerts !== "boolean") throw new Error("Teavituste valikud ei sobi.");
  if (!keysMatch(settings.backtest, ["fee_bps", "monthly_contribution"])) throw new Error("Võrdluse seadistus ei sobi.");
  const { fee_bps, monthly_contribution } = settings.backtest;
  if (!Number.isFinite(fee_bps) || fee_bps < 0 || fee_bps > 500
      || !Number.isFinite(monthly_contribution) || monthly_contribution <= 0 || monthly_contribution > 1000000) throw new Error("Võrdluse kulu või kuumakse ei sobi.");
  return settings;
}

async function secretMatches(candidate, expected) {
  if (typeof expected !== "string" || candidate.length > 256) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const leftBytes = new Uint8Array(left), rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

async function readProfile(env, id) {
  const stored = await env.PROFILES.get(id, "json");
  return {
    id, name: "Kasutaja " + id.at(-1),
    enabled: stored !== null,
    updated_at: stored?.updated_at ?? null,
    settings: stored ? validateSettings(stored.settings) : defaultSettings()
  };
}

function ready(env) {
  const codes = PROFILE_IDS.map((id) => env["PROFILE_" + id.at(-1) + "_CODE"]);
  return env.PROFILES && env.AUTH_LIMITER && /^https:\/\/[^/]+$/.test(env.ALLOWED_ORIGIN ?? "")
    && codes.every((code) => typeof code === "string" && code.length >= 4)
    && new Set(codes).size === 3
    && typeof env.AUTOMATION_TOKEN === "string" && env.AUTOMATION_TOKEN.length >= 32
    && !codes.includes(env.AUTOMATION_TOKEN);
}

async function handleChartRequest(url, headers, reply) {
  const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase().replace(".", "-");
  if (!/^[A-Z0-9_-]{1,12}$/.test(symbol)) {
    return reply({ error: "Vigane aktsia sümbol." }, 400);
  }
  const allowedIntervals = new Set(["1m", "2m", "5m", "15m", "60m", "1d"]);
  const allowedRanges = new Set(["1d", "5d", "1mo", "3mo", "1y", "2y"]);
  const interval = allowedIntervals.has(url.searchParams.get("interval")) ? url.searchParams.get("interval") : "1d";
  const range = allowedRanges.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "2y";
  const hosts = ["https://query2.finance.yahoo.com", "https://query1.finance.yahoo.com"];
  for (const host of hosts) {
    try {
      const upstream = await fetch(
        host + "/v8/finance/chart/" + encodeURIComponent(symbol)
          + "?interval=" + interval + "&range=" + range + "&includeAdjustedClose=true",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
      );
      if (upstream.ok) {
        return new Response(await upstream.text(), { status: 200, headers });
      }
    } catch {
      // Try next Yahoo host.
    }
  }
  return reply({ error: "Yahoo Finance ei vastanud sümbolile " + symbol + "." }, 502);
}

export async function handleRequest(request, env) {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const headers = {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Vary": "Origin", "X-Content-Type-Options": "nosniff"
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const isLocalOrigin = origin === "http://localhost:8000" || origin === "http://127.0.0.1:8000";
  const isChartEndpoint = url.pathname === "/v1/chart";

  if (origin && origin !== env.ALLOWED_ORIGIN && !(isChartEndpoint && isLocalOrigin)) {
    return reply({ error: "See veebiaadress ei ole lubatud." }, 403);
  }
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  if (request.method === "OPTIONS") {
    headers["Access-Control-Allow-Methods"] = "GET, PUT, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    return new Response(null, { status: 204, headers });
  }
  if (isChartEndpoint && request.method === "GET") {
    return handleChartRequest(url, headers, reply);
  }
  if (!ready(env)) return reply({ error: "Profiiliteenus vajab omaniku seadistust." }, 503);
  if (url.pathname === "/health" && request.method === "GET") return reply({ ready: true });
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  try {
    // The automation credential can only read profiles; it cannot change them.
    if (url.pathname === "/v1/profiles" && request.method === "GET") {
      if (!await secretMatches(token, env.AUTOMATION_TOKEN)) return reply({ error: "Ligipääs puudub." }, 401);
      return reply({ profiles: await Promise.all(PROFILE_IDS.map((id) => readProfile(env, id))) });
    }
    const match = url.pathname.match(/^\/v1\/profiles\/(user-[123])$/);
    if (!match) return reply({ error: "Aadressi ei leitud." }, 404);
    if (!["GET", "PUT"].includes(request.method)) return reply({ error: "Meetod ei ole lubatud." }, 405);
    const id = match[1];
    const limit = await env.AUTH_LIMITER.limit({ key: "stock-radar:" + id + ":" + (request.headers.get("CF-Connecting-IP") ?? "unknown") });
    if (!limit.success) return reply({ error: "Liiga palju katseid. Oota minut ja proovi uuesti." }, 429);
    if (!await secretMatches(token, env["PROFILE_" + id.at(-1) + "_CODE"])) return reply({ error: "Profiili kood ei sobi." }, 401);
    if (request.method === "GET") return reply(await readProfile(env, id));
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply({ error: "Ootan JSON-seadistust." }, 415);
    if (Number(request.headers.get("Content-Length")) > 8192) return reply({ error: "Seadistus on liiga suur." }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 8192) return reply({ error: "Seadistus on liiga suur." }, 413);
    let settings;
    try { settings = validateSettings(JSON.parse(text)); }
    catch { return reply({ error: "Seadistus ei sobi. Kontrolli hindu, teavitusi ja võrdluse väärtusi." }, 400); }
    const record = { settings, updated_at: new Date().toISOString() };
    await env.PROFILES.put(id, JSON.stringify(record));
    return reply({ id, name: "Kasutaja " + id.at(-1), enabled: true, ...record });
  } catch {
    return reply({ error: "Profiili lugemine või salvestamine ebaõnnestus. Proovi hiljem uuesti." }, 503);
  }
}

export default { fetch: handleRequest };
