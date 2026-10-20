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
  const baseSettings = JSON.parse(fs.readFileSync(path.join(projectRoot, "settings.json"), "utf8"));
  const remoteProfiles = new Map(["user-1", "user-2", "user-3"].map((id) => [id, {
    id, name: "Kasutaja " + id.at(-1), enabled: false, updated_at: null, settings: structuredClone(baseSettings)
  }]));
  let exported = null;
  function node(tag) {
    let value = "";
    return { tag, children: [], attributes: {}, handlers: {}, checked: false, disabled: true, textContent: "",
      get value() { return value; }, set value(input) { value = String(input); },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      setAttribute(key, input) { this.attributes[key] = input; },
      addEventListener(event, callback) { this.handlers[event] = callback; },
      click() { this.handlers.click?.(); },
      contains(target) { return this === target || this.children.some((item) => typeof item === "object" && item.contains(target)); }
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    assert.ok(!nodes.has(id), "Duplicate HTML id: " + id);
    nodes.set(id, node("div"));
  }
  const meta = {};
  const document = { documentElement: { dataset: {} }, getElementById(id) { return nodes.get(id) ?? null; },
    createElement: node, createElementNS(ns, tag) { return node(tag); }, querySelector() { return meta; } };
  const context = vm.createContext({
    document, Intl, console, structuredClone, Blob, AbortSignal,
    setTimeout(fn) { fn(); },
    URL: class extends URL { static createObjectURL(blob) { exported = blob; return "blob:test"; } static revokeObjectURL() {} },
    localStorage: {
      getItem(key) { return saved.get(key) ?? null; },
      setItem(key, input) { if (options.storageBlocked) throw Error("blocked"); saved.set(key, input); }
    },

    fetch: async (name, optionsForRequest = {}) => {
      if (options.settingsFailure && name === "settings.json") return { ok: false };
      if (name === "profile-config.json" && options.profileApi) return { ok: true, json: async () => ({ api_url: "https://profiles.example" }) };
      if (name.startsWith("https://profiles.example/")) {
        const id = name.split("/").at(-1);
        if (optionsForRequest.headers.Authorization !== "Bearer test-" + id + "-code") return { ok: false, json: async () => ({ error: "Vale kood." }) };
        if (optionsForRequest.method === "PUT") {
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
  return { context, nodes, saved, remoteProfiles, exported: () => exported };
}

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
  page.nodes.get("profile-code").value = "test-user-1-code";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.nodes.get("settings-save").disabled, false);
  page.nodes.get("target-KO").value = "60";
  await page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, 60);
  assert.match(page.nodes.get("settings-status").textContent, /salvestatud/);
  assert.equal(page.saved.has("stock-radar-settings"), false);
  page.nodes.get("profile-select").value = "user-2";
  page.nodes.get("profile-select").handlers.change();
  assert.equal(page.nodes.get("target-KO").value, "");
  assert.equal(page.nodes.get("settings-save").disabled, true);
  page.nodes.get("profile-code").value = "test-user-2-code";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  assert.equal(page.nodes.get("target-KO").value, "");
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, 60);
  assert.equal(page.nodes.get("profile-code").value, "");
});

test("failed server saves do not claim success or persist new local targets", async () => {
  const page = await loadPage("tradingview.html", { profileApi: true, profileSaveFailure: true });
  page.nodes.get("profile-code").value = "test-user-1-code";
  await page.nodes.get("profile-form").handlers.submit({ preventDefault() {} });
  page.nodes.get("target-KO").value = "61";
  await page.nodes.get("research-form").handlers.submit({ preventDefault() {} });
  assert.match(page.nodes.get("settings-status").textContent, /ei õnnestunud/);
  assert.equal(page.remoteProfiles.get("user-1").settings.targets.KO, null);
  assert.equal(page.saved.has("stock-radar-settings"), false);
});
