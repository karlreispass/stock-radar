const { test } = require("node:test");
const assert = require("node:assert/strict");
const worker = import("../backend/worker.mjs");
const origin = "https://karlreispass.github.io";

function environment() {
  const records = new Map();
  return {
    records, ALLOWED_ORIGIN: origin,
    PROFILE_1_CODE: "test-user-one-code", PROFILE_2_CODE: "test-user-two-code", PROFILE_3_CODE: "test-user-three-code",
    AUTOMATION_TOKEN: "test-automation-credential-at-least-32-characters",
    AUTH_LIMITER: { async limit() { return { success: true }; } },
    PROFILES: {
      async get(id) { return records.has(id) ? JSON.parse(records.get(id)) : null; },
      async put(id, value) { records.set(id, value); }
    }
  };
}
function request(path, code, options = {}) {
  return new Request("https://profiles.example" + path, {
    method: options.method ?? "GET",
    headers: { Origin: options.origin ?? origin, Authorization: "Bearer " + code,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {})
  });
}

test("new profiles are inactive until saved, and saves remain isolated", async () => {
  const { handleRequest, defaultSettings } = await worker;
  const env = environment();
  let response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE), env);
  assert.equal((await response.json()).enabled, false);
  const settings = defaultSettings();
  settings.targets.KO = 60;
  response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE, { method: "PUT", body: settings }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).enabled, true);
  response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE), env);
  assert.equal((await response.json()).settings.targets.KO, 60);
  response = await handleRequest(request("/v1/profiles/user-2", env.PROFILE_2_CODE), env);
  assert.equal((await response.json()).settings.targets.KO, null);
  assert.equal(env.records.size, 1);
});

test("one profile code cannot read or overwrite another profile", async () => {
  const { handleRequest, defaultSettings } = await worker;
  const env = environment();
  for (const method of ["GET", "PUT"]) {
    const response = await handleRequest(request("/v1/profiles/user-2", env.PROFILE_1_CODE, { method, ...(method === "PUT" ? { body: defaultSettings() } : {}) }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(env.records.size, 0);
});

test("automation can read all profiles but cannot write or retrieve codes", async () => {
  const { handleRequest, defaultSettings } = await worker;
  const env = environment();
  const response = await handleRequest(request("/v1/profiles", env.AUTOMATION_TOKEN), env);
  const data = await response.json();
  assert.equal(data.profiles.length, 3);
  assert.deepEqual(data.profiles.map((profile) => profile.name), ["Kasutaja 1", "Kasutaja 2", "Kasutaja 3"]);
  assert.ok(!JSON.stringify(data).includes(env.PROFILE_1_CODE));
  const write = await handleRequest(request("/v1/profiles/user-1", env.AUTOMATION_TOKEN, { method: "PUT", body: defaultSettings() }), env);
  assert.equal(write.status, 401);
  assert.equal(env.records.size, 0);
});

test("CORS, rate limits and missing bindings fail closed", async () => {
  const { handleRequest } = await worker;
  const env = environment();
  assert.equal((await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE, { origin: "https://other.example" }), env)).status, 403);
  const preflight = await handleRequest(new Request("https://profiles.example/v1/profiles/user-1", { method: "OPTIONS", headers: { Origin: origin } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  env.AUTH_LIMITER.limit = async () => ({ success: false });
  assert.equal((await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE), env)).status, 429);
  delete env.AUTH_LIMITER;
  assert.equal((await handleRequest(request("/health", ""), env)).status, 503);
});

test("malformed and oversized settings are rejected without saving", async () => {
  const { handleRequest, defaultSettings } = await worker;
  const env = environment();
  for (const body of ["{", { targets: {} }, { ...defaultSettings(), targets: { ...defaultSettings().targets, KO: -1 } }]) {
    const response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE, { method: "PUT", body }), env);
    assert.equal(response.status, 400);
  }
  const response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE, { method: "PUT", body: "x".repeat(9000) }), env);
  assert.equal(response.status, 413);
  assert.equal(env.records.size, 0);
});

test("storage errors return a controlled failure rather than reporting success", async () => {
  const { handleRequest, defaultSettings } = await worker;
  const env = environment();
  env.PROFILES.put = async () => { throw Error("private-storage-detail"); };
  const response = await handleRequest(request("/v1/profiles/user-1", env.PROFILE_1_CODE, { method: "PUT", body: defaultSettings() }), env);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-storage-detail"));
});
