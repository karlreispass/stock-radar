const { test } = require("node:test");
const assert = require("node:assert/strict");
const { movingAverage, analyzeStock, backtestStock } = require("../analysis.js");

function stockWithSignal(length = 300) {
  const history = Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), close: 100, rsi: 50
  }));
  history[194].rsi = 35;
  history[195].rsi = 35;
  history[198].close = 90;
  history[199] = { ...history[199], close: 110, rsi: 45 };
  history[200].close = 120;
  history[205].close = 60;
  return { history };
}

test("moving averages need enough observations and include the current close", () => {
  const history = Array.from({ length: 200 }, (_, index) => ({ close: index + 1 }));
  assert.equal(movingAverage(history, 48, 50), null);
  assert.equal(movingAverage(history, 49, 50), 25.5);
  assert.equal(movingAverage(history, 199, 200), 100.5);
});

test("historical candidate detection does not see future observations", () => {
  const stock = stockWithSignal();
  assert.equal(analyzeStock(stock, 199).candidate, true);
  const before = analyzeStock(stock, 199);
  stock.history[200] = { ...stock.history[200], close: 9999, rsi: 0 };
  assert.deepEqual(analyzeStock(stock, 199), before);
  assert.equal(analyzeStock(stock, 198).candidate, false);
});

test("entry is the next close and event returns include both transaction costs", () => {
  const result = backtestStock(stockWithSignal(), 10);
  const sample = result.outcomes[0].samples[0];
  assert.equal(sample.entryDate, stockWithSignal().history[200].date);
  assert.equal(sample.exitDate, stockWithSignal().history[205].date);
  assert.ok(Math.abs(sample.netReturn - (60 * 0.999 / (120 * 1.001) - 1) * 100) < 1e-9);
  assert.equal(sample.worstDrop, -50);
});

test("unfinished horizons are excluded separately", () => {
  const result = backtestStock(stockWithSignal(210));
  assert.equal(result.outcomes[0].count, 1);
  assert.equal(result.outcomes[1].count, 0);
  assert.equal(result.outcomes[1].averageReturn, null);
});

test("cash and monthly contributions are included equally in the comparison", () => {
  const stock = stockWithSignal();
  stock.history.forEach((point) => { point.close = 100; point.rsi = 50; });
  const result = backtestStock(stock, 0, 100);
  assert.equal(result.purchases, 0);
  assert.equal(result.cash, result.contributions);
  assert.ok(Math.abs(result.signalValue - result.regularValue) < 1e-9);
  assert.equal(result.outcomes[0].count, 0);
});

test("costs reduce net returns and invalid configuration is rejected", () => {
  assert.ok(backtestStock(stockWithSignal(), 20).outcomes[0].averageReturn < backtestStock(stockWithSignal(), 0).outcomes[0].averageReturn);
  for (const cost of [-1, 501, NaN]) assert.throws(() => backtestStock(stockWithSignal(), cost));
  assert.throws(() => backtestStock(stockWithSignal(), 10, 0));
});

test("short histories do not create fictitious trades", () => {
  const stock = { history: Array.from({length: 20}, () => ({close: 100, rsi: 35, date: "2025-01-01"})) };
  assert.equal(analyzeStock(stock).candidate, false);
  assert.equal(backtestStock(stock).contributions, 0);
});

const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const projectRoot = path.resolve(__dirname, "..");

async function loadPage(filename, options = {}) {
  const html = fs.readFileSync(path.join(projectRoot, filename), "utf8");
  const nodes = new Map(), saved = new Map();
  const session = options.session ?? new Map();
  const baseSettings = JSON.parse(fs.readFileSync(path.join(projectRoot, "settings.json"), "utf8"));
  const remoteProfiles = options.remoteProfiles ?? new Map(["user-1", "user-2", "user-3"].map((id) => [id, {
    id, name: "Kasutaja " + id.at(-1), enabled: false, updated_at: null, settings: structuredClone(baseSettings)
  }]));
  let exported = null;
  const timers = [];
  function node(tag) {
    let value = "";
    return { tag, children: [], attributes: {}, handlers: {}, checked: false, disabled: true, textContent: "",
      get value() { return value; }, set value(input) { value = String(input); },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      setAttribute(key, input) { this.attributes[key] = input; },
      addEventListener(event, callback) { this.handlers[event] = callback; },
      click() { this.handlers.click?.({ preventDefault() {} }); },
      showModal() { this.open = true; }, close() { this.open = false; },
      contains(target) { return this === target || this.children.some((item) => typeof item === "object" && item.contains(target)); }
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    assert.ok(!nodes.has(id), "Duplicate HTML id: " + id);
    nodes.set(id, node("div"));
  }
  const meta = {};
  const document = { documentElement: { dataset: {} }, visibilityState: "visible", getElementById(id) { return nodes.get(id) ?? null; },
    createElement: node, createElementNS(ns, tag) { return node(tag); }, querySelector() { return meta; } };
  const context = vm.createContext({
    document, Intl, console, structuredClone, Blob, AbortSignal,
    window: { addEventListener() {} }, confirm: () => options.confirmDiscard !== false,
    sessionStorage: {
      getItem(key) { if (options.sessionBlocked) throw Error("blocked"); return session.get(key) ?? null; },
      setItem(key, value) { if (options.sessionBlocked) throw Error("blocked"); session.set(key, value); },
      removeItem(key) { if (options.sessionBlocked) throw Error("blocked"); session.delete(key); }
    },
    setTimeout(fn) { fn(); },
    setInterval(callback, milliseconds) { timers.push({ callback, milliseconds }); },
    URL: class extends URL { static createObjectURL(blob) { exported = blob; return "blob:test"; } static revokeObjectURL() {} },
    localStorage: {
      getItem(key) { return saved.get(key) ?? null; },
      setItem(key, input) { if (options.storageBlocked) throw Error("blocked"); saved.set(key, input); }
    },

    fetch: async (name, optionsForRequest = {}) => {
      if (name === "data/stocks.json" && options.dataFailure) throw Error("Network unavailable");
      if (name === "data/stocks.json" && options.data) return { ok: true, json: async () => structuredClone(options.data) };
      if (options.settingsFailure && name === "settings.json") return { ok: false };
      if (name === "profile-config.json" && options.profileApi) return { ok: true, json: async () => ({ api_url: "https://profiles.example" }) };
      if (name.startsWith("https://profiles.example/")) {
        const id = name.split("/").at(-1);
        if (optionsForRequest.headers.Authorization !== "Bearer " + id.at(-1).repeat(4)) return { ok: false, json: async () => ({ error: "Vale kood." }) };
        if (optionsForRequest.method === "PUT") {
          if (options.saveGate) await options.saveGate;
          if (options.profileSaveFailure) return { ok: false, json: async () => ({ error: "Teenuse tõrge." }) };
          remoteProfiles.set(id, { id, name: "Kasutaja " + id.at(-1), enabled: true, updated_at: "2026-10-20T22:30:00Z", settings: JSON.parse(optionsForRequest.body) });
        }
        return { ok: true, json: async () => structuredClone(remoteProfiles.get(id)) };
      }
      const data = JSON.parse(fs.readFileSync(path.join(projectRoot, name), "utf8"));
      return { ok: true, json: async () => data };
    }

  });
  for (const [, name] of html.matchAll(/<script src="([^"]+)" defer><\/script>/g)) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, name), "utf8"), context);
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { context, nodes, saved, session, remoteProfiles, timers, exported: () => exported };
}

test("intraday quotes update prices without changing daily RSI or selected stock", async () => {
  const data = JSON.parse(fs.readFileSync(path.join(projectRoot, "data/stocks.json"), "utf8"));
  const dailyHistory = structuredClone(data.stocks[0].history);
  const lastDay = dailyHistory.at(-1).date;
  const quoteDay = new Date(Date.parse(lastDay) + 86400000).toISOString().slice(0, 10);
  data.stocks[0].quote = { price: 999, as_of: quoteDay + "T15:00:00Z", date: quoteDay };
  const page = await loadPage("index.html", { data });
  assert.match(page.nodes.get("stock-list").children[0].children[1].children[0].textContent, /999/);
  assert.match(page.nodes.get("latest-quote").textContent, /999/);
  assert.equal(page.nodes.get("detail-rsi").textContent, new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(dailyHistory.at(-1).rsi));
  assert.deepEqual(data.stocks[0].history, dailyHistory);
  const baseline = dailyHistory.at(-1).quote_close ?? dailyHistory.at(-1).close;
  assert.equal(vm.runInContext("quoteSummary(state.data.stocks[0]).change", page.context), (999 / baseline - 1) * 100);
  page.nodes.get("stock-list").children[1].children[0].children[0].handlers.click();
  page.nodes.get("quick-target").value = "123";
  const timer = page.timers.find((item) => item.milliseconds === 60000);
  assert.ok(timer);
  data.stocks[0].quote.price = 1001;
  data.generated_at = new Date(Date.parse(data.generated_at) + 60000).toISOString();
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.nodes.get("stock-list").children[0].children[1].children[0].textContent, /1\s?001/);
  assert.match(page.nodes.get("detail-title").textContent, /PEP/);
  assert.equal(page.nodes.get("quick-target").value, "123");
});

test("failed or invalid background refresh keeps the displayed snapshot", async () => {
  const options = { data: JSON.parse(fs.readFileSync(path.join(projectRoot, "data/stocks.json"), "utf8")) };
  const page = await loadPage("tradingview.html", options);
  const originalRows = page.nodes.get("stock-list").children;
  options.dataFailure = true;
  await vm.runInContext("loadData(true)", page.context);
  assert.equal(page.nodes.get("stock-list").children, originalRows);
  assert.match(page.nodes.get("notice").textContent, /eelmise laadimise/);
  options.dataFailure = false;
  options.data.stocks[0].quote = { price: -1, as_of: "invalid", date: "invalid" };
  await vm.runInContext("loadData(true)", page.context);
  assert.equal(page.nodes.get("stock-list").children, originalRows);
});

test("both pages render research and preserve daily assessments when stocks change", async () => {
  for (const filename of ["index.html", "tradingview.html"]) {
    const { nodes } = await loadPage(filename);
    assert.equal(nodes.get("stock-list").children.length, 5);
    assert.equal(nodes.get("backtest-results").children.length, 3);
    assert.equal(nodes.get("settings-save").disabled, false);
    assert.ok(nodes.get("average-200").textContent.length > 0);
    nodes.get("stock-list").children[1].children[0].children[0].handlers.click();
    assert.match(nodes.get("detail-title").textContent, /PEP/);
    assert.match(nodes.get("backtest-period").textContent, /PEP/);
    if (filename === "index.html") {
      const chart = nodes.get("price-chart");
      assert.ok(!JSON.stringify(chart).includes("NaN"));
      const paths = chart.children[0].children.filter((item) => item.tag === "path");
      assert.ok(paths.some((item) => item.attributes.stroke === "var(--trend200)"));
    } else {
      const widget = nodes.get("tradingview-chart").children[0];
      const script = widget.children.find((item) => item.tag === "script");
      assert.equal(JSON.parse(script.textContent).symbol, "NASDAQ:PEP");
      assert.ok(JSON.parse(script.textContent).studies.includes("RSI@tv-basicstudies"));
    }
  }
});

test("target settings persist locally and export the same automation configuration", async () => {
  const page = await loadPage("index.html");
  page.nodes.get("target-KO").value = "60";
  page.nodes.get("event-watch").checked = false;
  page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  const saved = JSON.parse(page.saved.get("stock-radar-settings"));
  assert.equal(saved.targets.KO, 60);
  assert.equal(saved.events.watch, false);
  assert.match(page.nodes.get("settings-status").textContent, /erinevad/);
  page.nodes.get("settings-export").handlers.click();
  assert.deepEqual(JSON.parse(await page.exported().text()), saved);
});

test("blocked storage and missing settings do not break the main view", async () => {
  const blocked = await loadPage("index.html", { storageBlocked: true });
  blocked.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.match(blocked.nodes.get("settings-status").textContent, /ei lubanud/);
  const failed = await loadPage("tradingview.html", { settingsFailure: true });
  assert.equal(failed.nodes.get("stock-list").children.length, 5);
  assert.ok(failed.nodes.get("tradingview-chart").children.length > 0);
  assert.match(failed.nodes.get("settings-status").textContent, /ei saanud laadida/);
});

test("server profiles save without exporting a file and keep users separate", async () => {
  const page = await loadPage("index.html", { profileApi: true });
  assert.equal(page.nodes.get("settings-save").disabled, true);
  assert.equal(page.nodes.get("settings-export").hidden, true);
  page.nodes.get("profile-code").value = "1111";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.nodes.get("settings-save").disabled, false);
  page.nodes.get("target-KO").value = "60";
  await page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, 60);
  assert.match(page.nodes.get("settings-status").textContent, /Salvestatud/);
  assert.equal(page.saved.has("stock-radar-settings"), false);
  page.nodes.get("profile-select").value = "user-2";
  page.nodes.get("profile-select").handlers.change();
  assert.equal(page.nodes.get("target-KO").value, "");
  assert.equal(page.nodes.get("settings-save").disabled, true);
  page.nodes.get("profile-code").value = "2222";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.nodes.get("target-KO").value, "");
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, 60);
  assert.equal(page.nodes.get("profile-code").value, "");
});

test("failed server saves do not claim success or persist new local targets", async () => {
  const page = await loadPage("tradingview.html", { profileApi: true, profileSaveFailure: true });
  page.nodes.get("profile-code").value = "1111";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  page.nodes.get("target-KO").value = "61";
  await page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.match(page.nodes.get("settings-status").textContent, /ei õnnestunud/);
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, null);
  assert.equal(page.saved.has("stock-radar-settings"), false);
});


test("a signed-in session follows navigation and reload but logout clears it", async () => {
  const first = await loadPage("index.html", { profileApi: true });
  first.nodes.get("account-button").click();
  assert.equal(first.nodes.get("login-dialog").open, true);
  first.nodes.get("profile-select").value = "user-2";
  first.nodes.get("profile-select").handlers.change();
  first.nodes.get("profile-code").value = "2222";
  await first.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  first.nodes.get("target-KO").value = "57";
  await first.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.equal(first.nodes.get("login-dialog").open, false);
  assert.equal(first.saved.has("stock-radar-session"), false);
  for (const filename of ["tradingview.html", "index.html"]) {
    const next = await loadPage(filename, { profileApi: true, session: first.session, remoteProfiles: first.remoteProfiles });
    assert.match(next.nodes.get("account-button").textContent, /Kasutaja 2/);
    assert.equal(next.nodes.get("target-KO").value, "57");
    assert.equal(next.nodes.get("quick-target").value, "57");
    assert.equal(next.nodes.get("settings-save").disabled, false);
  }
  first.nodes.get("profile-lock").click();
  assert.equal(first.session.has("stock-radar-session"), false);
  assert.equal(first.nodes.get("target-KO").value, "");
  const guest = await loadPage("tradingview.html", { profileApi: true, session: first.session });
  assert.equal(guest.nodes.get("account-button").textContent, "Logi sisse");
  assert.equal(guest.nodes.get("settings-save").disabled, true);
});

test("quick targets share settings, save the selected stock and preserve other targets", async () => {
  const page = await loadPage("index.html", { profileApi: true });
  page.nodes.get("profile-code").value = "1111";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  page.nodes.get("quick-target").value = "60";
  page.nodes.get("quick-target").handlers.input();
  assert.match(page.nodes.get("quick-save-status").textContent, /Salvestamata/);
  page.nodes.get("stock-list").children[1].children[0].children[0].handlers.click();
  assert.equal(page.nodes.get("quick-target").value, "");
  assert.match(page.nodes.get("quick-target-label").textContent, /PEP/);
  page.nodes.get("quick-target").value = "140";
  await page.nodes.get("quick-target-form").handlers.submit({ preventDefault() {} });
  const targets = page.remoteProfiles.get("user-1").settings.targets;
  assert.equal(targets.KO, 60);
  assert.equal(targets.PEP, 140);
  assert.match(page.nodes.get("quick-save-status").textContent, /Salvestatud/);
  page.nodes.get("quick-settings").click();
  assert.equal(page.nodes.get("settings-dialog").open, true);
});

test("invalid restored sessions stay locked and blocked storage still permits manual sign-in", async () => {
  const session = new Map([["stock-radar-session", JSON.stringify({ id: "user-3", code: "wrong" })]]);
  const rejected = await loadPage("index.html", { profileApi: true, session });
  assert.equal(rejected.nodes.get("settings-save").disabled, true);
  assert.equal(session.has("stock-radar-session"), false);
  assert.equal(rejected.nodes.get("profile-notice").hidden, false);
  const blocked = await loadPage("tradingview.html", { profileApi: true, sessionBlocked: true });
  blocked.nodes.get("profile-code").value = "1111";
  await blocked.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  assert.equal(blocked.nodes.get("settings-save").disabled, false);
  assert.equal(blocked.nodes.get("profile-notice").hidden, false);
  assert.match(blocked.nodes.get("profile-notice").textContent, /uuesti sisse/);
});

test("switching profiles asks before discarding edits and clears old values after approval", async () => {
  const page = await loadPage("index.html", { profileApi: true, confirmDiscard: false });
  page.nodes.get("profile-code").value = "1111";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  page.nodes.get("target-KO").value = "55";
  page.nodes.get("profile-switch").click();
  assert.match(page.nodes.get("account-button").textContent, /Kasutaja 1/);
  assert.equal(page.nodes.get("target-KO").value, "55");
  const approved = await loadPage("index.html", { profileApi: true, session: page.session });
  approved.nodes.get("target-KO").value = "55";
  approved.nodes.get("profile-switch").click();
  assert.equal(approved.nodes.get("target-KO").value, "");
  assert.equal(approved.nodes.get("login-dialog").open, true);
  assert.equal(approved.nodes.get("account-button").textContent, "Logi sisse");
});


test("a late save response cannot overwrite the newly signed-in profile", async () => {
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const page = await loadPage("index.html", { profileApi: true, saveGate });
  page.nodes.get("profile-code").value = "1111";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  page.nodes.get("target-KO").value = "60";
  const pendingSave = page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.nodes.get("quick-target-save").disabled, true);
  assert.equal(page.nodes.get("settings-save").textContent, "Salvestan…");
  page.nodes.get("profile-switch").click();
  page.nodes.get("profile-select").value = "user-2";
  page.nodes.get("profile-select").handlers.change();
  page.nodes.get("profile-code").value = "2222";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  releaseSave();
  await pendingSave;
  assert.match(page.nodes.get("account-button").textContent, /Kasutaja 2/);
  assert.equal(page.nodes.get("target-KO").value, "");
  assert.equal(page.nodes.get("settings-save").disabled, false);
  assert.equal(page.nodes.get("settings-save").textContent, "Salvesta profiil");
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, 60);
  assert.equal(page.remoteProfiles.get("user-2").settings.targets.KO, null);
});
