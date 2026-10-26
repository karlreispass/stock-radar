const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadExplorer(options = {}) {
  const nodes = new Map();
  function node(tag = "div") {
    return {
      tag, textContent: "", children: [], handlers: {}, dataset: {}, attributes: {}, hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; this.textContent = ""; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelectorAll() { return this.children.filter((child) => child.tag === "button"); },
      querySelector() { return this.children.find((child) => child.dataset.list === "kings") || null; },
      classList: { toggle() {} }
    };
  }
  const html = fs.readFileSync(path.join(root, "explorer.html"), "utf8");
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(id, node());
  for (const [id, attribute] of [["list-mode-controls", "list"], ["chart-mode-controls", "mode"], ["ranges", "days"], ["kings-filters", "filter"]]) {
    const group = html.slice(html.indexOf('id="' + id + '"')).split("</div>")[0];
    for (const [, value] of group.matchAll(new RegExp('data-' + attribute + '="([^"]+)"', "g"))) {
      const button = node("button");
      button.dataset[attribute] = value;
      nodes.get(id).append(button);
    }
  }
  const storage = options.storage || new Map();
  const session = new Map();
  const clock = { now: Date.now() };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  let timer;
  const context = vm.createContext({
    Intl, Date: TestDate, URL, console, structuredClone, AbortSignal,
    document: {
      documentElement: { dataset: {} }, visibilityState: "visible",
      getElementById: (id) => nodes.get(id),
      createElement: node, createElementNS: (namespace, tag) => node(tag), querySelector: node
    },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
    setInterval(callback) { timer = callback; },
    setTimeout(callback) { callback(); },
    fetch: async () => { throw new Error("Unexpected network request"); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "analysis.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(root, "explorer.js"), "utf8");
  // Each test controls startup so snapshots and delayed network replies are deterministic.
  vm.runInContext(source.replace("initializeExplorer().catch(showInitializationError);", ""), context);
  const run = (code) => vm.runInContext(code, context);
  context.companies = JSON.parse(fs.readFileSync(path.join(root, "data/dividend-kings.json"), "utf8"));
  run("DIVIDEND_KINGS_LIST.push(...companies)");
  return { context, nodes, run, timer, storage, clock, state: run("explorerState") };
}

function stock(symbol = "KO", date = "2026-10-20") {
  const end = Date.parse(date + "T00:00:00Z");
  return {
    symbol, name: symbol, sourceMode: "provider", liveTime: date,
    history: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(end - (29 - index) * 86400000).toISOString().slice(0, 10),
      close: 100 + index, quote_close: 100 + index, rsi: 50
    }))
  };
}

function mockQuotes(page, callback) {
  page.context.quoteRequest = callback;
  page.run("fetchYahooSymbol = (...args) => quoteRequest(...args)");
}

function phQuote(price, time) {
  const data = stock("PH", time.slice(0, 10));
  data.liveTime = time;
  data.history.at(-1).close = price;
  data.history.at(-1).quote_close = price;
  return data;
}

test("a fresher PH quote appears in the chart header and as a separate price line", () => {
  const page = loadExplorer();
  const daily = stock("PH", "2026-10-23");
  daily.sourceMode = "snapshot";
  daily.history.at(-1).close = 880;
  daily.history.at(-1).quote_close = 880;
  daily.quote = { price: 896, as_of: "2026-10-26T14:35:00Z", date: "2026-10-26" };
  daily.liveTime = daily.quote.as_of;
  page.state.marketData.set("PH", daily);
  page.state.selected = "PH";
  page.run("renderDetail()");

  assert.match(page.nodes.get("detail-price").textContent, /896/);
  assert.match(page.nodes.get("history-price").textContent, /880/);
  const priceChart = page.nodes.get("price-chart").children[0];
  const quoteLine = priceChart.children.find((item) => item.tag === "line" && item.attributes["aria-label"]?.includes("896"));
  assert.ok(quoteLine);
  assert.match(quoteLine.children[0].textContent, /2026-10-26T14:35:00Z/);
  assert.ok(!page.nodes.get("rsi-chart").children[0].children.some((item) => item.attributes?.["aria-label"]?.includes("896")));
  assert.equal(daily.history.at(-1).close, 880);
});

test("a cached Friday quote cannot replace Monday's published PH price", async () => {
  const page = loadExplorer();
  const current = stock("PH", "2026-10-23");
  current.sourceMode = "snapshot";
  current.liveTime = "2026-10-26T14:35:00Z";
  current.quote = { price: 896, as_of: current.liveTime, date: "2026-10-26" };
  current.fetchedAt = page.clock.now;
  page.state.marketData.set("PH", current);
  page.context.oldQuote = phQuote(880, "2026-10-23T20:00:00Z");
  page.run("writeSessionCache('PH:1d:5d', oldQuote)");
  await page.run("loadStockData({symbol:'PH',name:'PH'}, true)");
  const result = page.run("quoteSummary('PH')");
  assert.equal(result.price, 896);
  assert.equal(result.time, "2026-10-26T14:35:00Z");
});

test("an older history response preserves both a newer quote and daily history", async () => {
  const page = loadExplorer();
  const current = phQuote(896, "2026-10-26T14:35:00Z");
  page.state.marketData.set("PH", current);
  mockQuotes(page, async () => phQuote(880, "2026-10-23T20:00:00Z"));
  assert.equal(await page.run("loadStockData({symbol:'PH',name:'PH'}, false)"), false);
  assert.equal(page.run("quoteSummary('PH').price"), 896);
  assert.equal(page.state.marketData.get("PH"), current);
});

test("a newer lower PH quote is accepted by its observation time", async () => {
  const page = loadExplorer();
  const current = phQuote(896, "2026-10-26T14:35:00Z");
  current.fetchedAt = page.clock.now;
  page.state.marketData.set("PH", current);
  mockQuotes(page, async () => phQuote(880, "2026-10-26T14:36:00Z"));
  await page.run("loadStockData({symbol:'PH',name:'PH'}, true)");
  const result = page.run("quoteSummary('PH')");
  assert.equal(result.price, 880);
  assert.equal(result.time, "2026-10-26T14:36:00Z");
});

test("a delayed history refresh cannot erase a newer short quote", async () => {
  const page = loadExplorer();
  page.state.marketData.set("PH", phQuote(880, "2026-10-23T20:00:00Z"));
  let finishHistory;
  mockQuotes(page, () => new Promise((resolve) => { finishHistory = resolve; }));
  const pending = page.run("loadStockData({symbol:'PH',name:'PH'}, false)");
  const freshQuote = phQuote(896, "2026-10-26T14:36:00Z");
  page.state.latestQuotes.set("PH", freshQuote);
  finishHistory(phQuote(890, "2026-10-26T14:35:00Z"));
  await pending;
  assert.equal(page.run("quoteSummary('PH').price"), 896);
  assert.equal(page.state.latestQuotes.get("PH"), freshQuote);
});

test("published snapshots preserve newer quotes in either direction", async () => {
  const page = loadExplorer();
  const current = phQuote(896, "2026-10-26T14:35:00Z");
  page.state.marketData.set("PH", current);
  page.state.latestQuotes.set("PH", phQuote(880, "2026-10-23T20:00:00Z"));
  let published = phQuote(879, "2026-10-23T20:00:00Z");
  published.quote = { price: 879, as_of: published.liveTime, date: "2026-10-23" };
  page.context.fetch = async () => ({ ok: true, json: async () => ({ mode: "live", stocks: [published] }) });
  await page.run("loadPublishedSnapshots()");
  assert.equal(page.run("quoteSummary('PH').price"), 896);
  published = phQuote(881, "2026-10-26T14:36:00Z");
  published.quote = { price: 881, as_of: published.liveTime, date: "2026-10-26" };
  await page.run("loadPublishedSnapshots()");
  assert.equal(page.run("quoteSummary('PH').price"), 881);
  assert.equal(page.state.marketData.get("PH"), current);
});

test("a successful provider response with an older observation is rejected", async () => {
  const page = loadExplorer();
  page.state.latestQuotes.set("PH", phQuote(896, "2026-10-26T14:35:00Z"));
  page.context.provider = { url: "https://provider.example", parse: () => phQuote(880, "2026-10-23T20:00:00Z") };
  page.context.fetch = async () => ({ ok: true, text: async () => "unused" });
  await assert.rejects(page.run("fetchViaProvider(provider, 'PH', '', false, 1)"), /vanem/);
});

test("published quotes refresh every minute without replacing newer provider prices", async () => {
  const page = loadExplorer();
  const daily = stock();
  daily.sourceMode = "snapshot";
  page.state.marketData.set("KO", daily);
  page.state.latestQuotes.set("KO", structuredClone(daily));
  const published = structuredClone(daily);
  published.quote = { price: 150, as_of: "2026-10-21T15:00:00Z", date: "2026-10-21" };
  const requests = [];
  page.context.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ mode: "live", stocks: url === "data/stocks.json" ? [published] : [] }) };
  };
  mockQuotes(page, async () => page.state.marketData.get("KO"));
  page.clock.now += 60000;
  page.timer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["data/kings.json", "data/stocks.json"]);
  const quote = page.run("quoteSummary('KO')");
  assert.equal(quote.price, 150);
  assert.equal(quote.time, published.quote.as_of);
  assert.equal(quote.change, (150 / daily.history.at(-1).quote_close - 1) * 100);
  assert.deepEqual(JSON.parse(JSON.stringify(page.state.marketData.get("KO").history)), daily.history);

  const provider = stock("KO", "2026-10-22");
  provider.liveTime = "2026-10-22T15:00:00Z";
  page.state.marketData.set("KO", provider);
  await page.run("loadPublishedSnapshots()");
  assert.equal(page.state.marketData.get("KO"), provider);
});

test("selected stock timer keeps refreshing during a background watchlist refresh", async () => {
  const page = loadExplorer();
  page.state.loading = true;
  page.state.marketData.set("KO", stock());
  const requests = [];
  const updated = stock("KO", "2026-10-21");
  mockQuotes(page, async (...args) => { requests.push(args); return updated; });
  page.timer();
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2], true);
  assert.equal(requests[0][3], "1d");
  assert.equal(page.state.marketData.get("KO").history.at(-1).date, "2026-10-21");
});

test("startup refreshes every snapshot stock and requests the selected one only once", async () => {
  const page = loadExplorer();
  page.state.listMode = "custom";
  page.state.customStocks = [{ symbol: "KO" }, { symbol: "PEP" }];
  for (const symbol of ["KO", "PEP"]) page.state.marketData.set(symbol, stock(symbol));
  const requests = [];
  mockQuotes(page, async (symbol) => { requests.push(symbol); return stock(symbol); });
  await page.run("refreshAllLiveStocks(true)");
  assert.deepEqual(requests, ["KO", "PEP"]);
  assert.equal(page.state.loading, false);
  assert.equal(page.nodes.get("refresh-live").disabled, false);
});

test("intraday prices from a new trading day never alter daily history or its RSI", async () => {
  const page = loadExplorer();
  const daily = stock();
  const original = structuredClone(daily);
  const intraday = stock("KO", "2026-10-21");
  intraday.history.forEach((point, index) => {
    point.date = new Date(Date.UTC(2026, 9, 21, 14, index)).toISOString();
    point.close = 500 + index;
    point.rsi = 10;
  });
  page.state.intraday = "1m";
  mockQuotes(page, async (symbol, name, cache, interval) => interval === "1d" ? daily : intraday);
  await page.run("refreshSelectedAndRender(false)");
  assert.deepEqual(daily, original);
  assert.equal(page.state.intradayData.get("KO:1m"), intraday);
  assert.match(page.nodes.get("detail-price").textContent, /529/);
  assert.match(page.nodes.get("average-position").textContent, /Üle keskmise/);
  assert.equal(page.nodes.get("rsi-trend").textContent, "Muutumatu 0,00 punkti");
});

test("snapshot source and date survive rendering without claiming a fresh realtime update", async () => {
  const page = loadExplorer();
  const saved = stock();
  page.context.fetch = async (url) => ({
    ok: true,
    json: async () => url === "profile-config.json" ? {} : {
      mode: "live", generated_at: "2026-10-20T18:00:00Z", stocks: [saved]
    }
  });
  await page.run("initConfigAndFallback()");
  assert.equal(page.state.marketData.get("KO").sourceMode, "snapshot");
  assert.equal(page.state.marketData.get("KO").isRealtime, false);
  page.run("renderOverview()");
  const label = page.nodes.get("custom-updated-at").textContent;
  assert.match(label, /20\.10\.2026/);
  assert.match(label, /Salvestatud andmed/);
  assert.doesNotMatch(label, /reaalajas|Uuendatud kell/);
  page.run("renderOverview()");
  assert.equal(page.nodes.get("custom-updated-at").textContent, label);
});

test("demo snapshots remain explicitly labelled and unknown RSI is not counted as low", async () => {
  const page = loadExplorer();
  const saved = stock();
  saved.history.at(-1).rsi = null;
  page.context.fetch = async (url) => ({
    ok: true, json: async () => url === "profile-config.json" ? {} : { mode: "demo", stocks: [saved] }
  });
  await page.run("initConfigAndFallback()");
  page.run("renderOverview(); renderDetail()");
  assert.match(page.nodes.get("custom-updated-at").textContent, /Näidisandmed/);
  assert.match(page.nodes.get("explorer-subtitle").textContent, /Näidisandmed/);
  assert.equal(page.nodes.get("custom-low-count").textContent, 0);
});

test("selecting a stock without history immediately clears the previous analysis", async () => {
  const page = loadExplorer();
  page.state.marketData.set("KO", stock());
  page.run("renderDetail()");
  assert.notEqual(page.nodes.get("assessment-title").textContent, "—");
  assert.ok(page.nodes.get("history-list").children.length);
  page.state.selected = "PEP";
  let rejectRequest;
  mockQuotes(page, () => new Promise((resolve, reject) => { rejectRequest = reject; }));
  const pending = page.run("refreshSelectedAndRender(false)");
  assert.match(page.nodes.get("explorer-title").textContent, /PEP/);
  for (const id of ["detail-price", "detail-rsi", "price-trend", "rsi-trend", "average-position", "average-50", "average-200", "assessment-title", "rsi-range"]) {
    assert.equal(page.nodes.get(id).textContent, "—", id);
  }
  assert.equal(page.nodes.get("history-list").children.length, 0);
  assert.equal(page.nodes.get("price-chart").children.length, 0);
  rejectRequest(new Error("offline"));
  await pending;
  assert.equal(page.nodes.get("assessment-title").textContent, "—");
});

test("a delayed request stays with its original interval and repeated timer ticks do not overlap", async () => {
  const page = loadExplorer();
  page.state.intraday = "1m";
  let resolveDaily;
  const requests = [];
  mockQuotes(page, (symbol, name, cache, interval) => {
    requests.push(interval);
    if (interval === "1d") return new Promise((resolve) => { resolveDaily = resolve; });
    return Promise.resolve(stock());
  });
  const pending = page.run("refreshSelectedAndRender(false)");
  const duplicate = page.run("refreshSelectedAndRender(false)");
  assert.deepEqual(requests, ["1d"]);
  page.state.intraday = "5m";
  page.state.selected = "PEP";
  resolveDaily(stock());
  await Promise.all([pending, duplicate]);
  assert.deepEqual(requests, ["1d", "1m"]);
  assert.ok(page.state.intradayData.has("KO:1m"));
  assert.equal(page.state.intradayData.has("KO:5m"), false);
  assert.match(page.nodes.get("explorer-title").textContent, /PEP/);
  assert.equal(page.state.selectedRefreshes.size, 0);
});

test("failed refresh keeps the previous daily data and its actual timestamp", async () => {
  const page = loadExplorer();
  const saved = stock();
  page.state.marketData.set("KO", saved);
  mockQuotes(page, async () => { throw new Error("offline"); });
  await page.run("refreshSelectedAndRender(false)");
  assert.equal(page.state.marketData.get("KO"), saved);
  assert.match(page.nodes.get("custom-updated-at").textContent, /20\.10\.2026/);
  assert.equal(page.state.selectedRefreshes.size, 0);
});

test("when all providers fail the fallback preserves newer prices already in memory", async () => {
  const page = loadExplorer();
  page.state.marketData.set("KO", stock("KO", "2026-10-21"));
  page.state.fallbackData.set("KO", stock("KO", "2026-10-19"));
  page.context.fetch = async () => { throw new Error("offline"); };
  const result = await page.run("fetchYahooSymbol('KO', '', false)");
  assert.equal(result.history.at(-1).date, "2026-10-21");
  assert.equal(result.liveTime, "2026-10-21");
});

test("minute bars cannot substitute for missing daily analysis", () => {
  const page = loadExplorer();
  page.state.intraday = "1m";
  page.state.marketData.set("KO", { error: "offline" });
  const intraday = stock();
  intraday.history.forEach((point, index) => {
    point.date = new Date(Date.UTC(2026, 9, 20, 14, index)).toISOString();
  });
  page.state.intradayData.set("KO:1m", intraday);
  page.run("renderDetail()");
  assert.equal(page.nodes.get("assessment-title").textContent, "Andmeid vähe");
  assert.equal(page.nodes.get("average-position").textContent, "Andmeid vähe");
  assert.equal(page.nodes.get("price-trend").textContent, "Andmeid vähe");
  assert.equal(page.nodes.get("native-chart-section").hidden, false);
});

test("sorting uses numeric RSI and daily change, keeps missing values last and preserves the watchlist", () => {
  const page = loadExplorer();
  page.state.listMode = "custom";
  page.state.customStocks = ["KO", "PEP", "AAPL", "MSFT"].map((symbol) => ({ symbol }));
  for (const [symbol, rsi, price] of [["KO", 8, 130], ["PEP", 75, 100], ["AAPL", 40, 140]]) {
    const data = stock(symbol);
    data.history.at(-1).rsi = rsi;
    data.history.at(-1).quote_close = price;
    page.state.marketData.set(symbol, data);
  }
  function sorted(order) {
    page.state.sortOrder = order;
    return Array.from(page.run("sortedListItems()"), (item) => item.symbol);
  }
  assert.deepEqual(sorted("rsi-asc"), ["KO", "AAPL", "PEP", "MSFT"]);
  assert.deepEqual(sorted("rsi-desc"), ["PEP", "AAPL", "KO", "MSFT"]);
  assert.deepEqual(sorted("change-desc"), ["AAPL", "KO", "PEP", "MSFT"]);
  assert.deepEqual(sorted("change-asc"), ["PEP", "KO", "AAPL", "MSFT"]);
  assert.deepEqual(sorted("default"), ["KO", "PEP", "AAPL", "MSFT"]);
  assert.deepEqual(page.state.customStocks.map((item) => item.symbol), ["KO", "PEP", "AAPL", "MSFT"]);
  page.nodes.get("sort-stocks").handlers.change({ target: { value: "rsi-desc" } });
  assert.equal(page.state.sortOrder, "rsi-desc");
  assert.equal(JSON.parse(page.storage.get("stock-radar-explorer-view")).sortOrder, "rsi-desc");
});

test("candidate sorting honours the daily assessment and works with the existing kings filter", () => {
  const page = loadExplorer();
  const candidate = stock("PEP");
  candidate.history.at(-2).close = 90;
  candidate.history.at(-1).close = 150;
  candidate.history.at(-6).rsi = 30;
  candidate.history.at(-3).rsi = 35;
  candidate.history.at(-1).rsi = 39;
  page.state.marketData.set("KO", stock());
  page.state.marketData.set("PEP", candidate);
  page.state.sortOrder = "candidate";
  assert.equal(page.run("sortedListItems()[0].symbol"), "PEP");
  page.state.kingsFilter = "low";
  assert.deepEqual(Array.from(page.run("sortedListItems()"), (item) => item.symbol), ["PEP"]);
});

test("view choices survive reload and restored buttons match the selected view", () => {
  const storage = new Map();
  const first = loadExplorer({ storage });
  Object.assign(first.state, {
    listMode: "custom", selected: "AAPL", days: 5, intraday: "5m",
    chartMode: "tradingview", sortOrder: "change-desc", kingsFilter: "low", kingsSearch: "Coca"
  });
  first.run("saveView()");
  const second = loadExplorer({ storage });
  second.run("restoreView(); syncViewControls()");
  for (const key of ["listMode", "selected", "days", "intraday", "chartMode", "sortOrder", "kingsFilter", "kingsSearch"]) {
    assert.equal(second.state[key], first.state[key], key);
  }
  assert.equal(second.nodes.get("sort-stocks").value, "change-desc");
  const selectedRange = second.nodes.get("ranges").children.find((button) => button.dataset.days === "5");
  assert.equal(selectedRange.attributes["aria-pressed"], "true");
  const selectedList = second.nodes.get("list-mode-controls").children.find((button) => button.dataset.list === "custom");
  assert.equal(selectedList.attributes["aria-pressed"], "true");
});

test("invalid preferences and unavailable storage do not break navigation", () => {
  const storage = new Map([["stock-radar-explorer-view", JSON.stringify({
    listMode: "custom", selected: "REMOVED", days: -5, intraday: "1h", chartMode: "unknown", sortOrder: "unknown"
  })]]);
  const page = loadExplorer({ storage });
  page.run("restoreView()");
  assert.equal(page.state.selected, "AAPL");
  assert.equal(page.state.days, 90);
  assert.equal(page.state.intraday, "");
  assert.equal(page.state.chartMode, "native");
  assert.equal(page.state.sortOrder, "default");
  page.context.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => page.run("restoreView(); saveView(); syncViewControls()"));
});

test("periodic refresh requests a short quote, expires history after 15 minutes and honours manual refresh", async () => {
  const page = loadExplorer();
  const requests = [];
  const original = stock();
  const quote = stock("KO", "2026-10-21");
  quote.history = quote.history.slice(-3);
  quote.history.at(-1).quote_close = 200;
  mockQuotes(page, async (symbol, name, cache, interval, range) => {
    requests.push({ interval, range, cache });
    return range === "5d" ? quote : original;
  });
  await page.run("refreshSelectedAndRender(true)");
  page.clock.now += 16000;
  await page.run("refreshSelectedAndRender(true)");
  assert.deepEqual(requests.map((request) => request.range), ["2y", "5d"]);
  assert.equal(page.state.marketData.get("KO").history.at(-1).close, 129);
  assert.equal(page.run("quoteSummary('KO').price"), 200);
  assert.match(page.nodes.get("latest-quote").textContent, /200,00/);
  page.clock.now += 15 * 60 * 1000;
  await page.run("refreshSelectedAndRender(true)");
  await page.run("refreshSelectedAndRender(false)");
  assert.deepEqual(requests.map((request) => request.range), ["2y", "5d", "2y", "2y"]);
  assert.equal(requests.at(-1).cache, false);
});

test("short provider responses are accepted for quotes and cached independently from RSI history", async () => {
  const page = loadExplorer();
  page.state.workerApiUrl = "https://quotes.example";
  const ranges = [];
  page.context.fetch = async (url) => {
    if (!url.startsWith("https://quotes.example/")) throw new Error("Backup unavailable");
    const range = new URL(url).searchParams.get("range");
    ranges.push(range);
    const rows = range === "5d" ? stock().history.slice(-3) : stock().history;
    return {
      ok: true,
      text: async () => JSON.stringify({ chart: { result: [{
        meta: {}, timestamp: rows.map((point) => Date.parse(point.date) / 1000),
        indicators: { quote: [{ close: rows.map((point) => point.quote_close) }] }
      }] } })
    };
  };
  await page.run("refreshSelectedAndRender(true)");
  page.clock.now += 16000;
  await page.run("refreshSelectedAndRender(true)");
  await page.run("refreshSelectedAndRender(true)");
  assert.deepEqual(ranges, ["2y", "5d"]);
  assert.equal(page.state.marketData.get("KO").history.length, 30);
  assert.equal(page.state.latestQuotes.get("KO").history.length, 3);
  assert.equal(page.state.latestQuotes.get("KO").history.at(-1).rsi, null);
  page.clock.now += 16000;
  await page.run("refreshSelectedAndRender(true)");
  assert.deepEqual(ranges, ["2y", "5d", "5d"]);
});

test("progress reports both provider failures and fallback data while retaining usable history", async () => {
  const page = loadExplorer();
  page.state.listMode = "custom";
  page.state.customStocks = ["KO", "PEP", "AAPL"].map((symbol) => ({ symbol }));
  const fallback = { ...stock(), refreshFailed: true };
  mockQuotes(page, async (symbol) => {
    if (symbol === "KO") return fallback;
    if (symbol === "PEP") {
      assert.match(page.nodes.get("refresh-progress").textContent, /Kontrollitud 1\/3/);
      throw new Error("offline");
    }
    return stock(symbol);
  });
  await page.run("refreshAllLiveStocks(false)");
  const progress = page.nodes.get("refresh-progress");
  assert.equal(progress.hidden, false);
  assert.match(progress.textContent, /Kontrollitud 3\/3/);
  assert.match(progress.textContent, /Ebaõnnestus 2 \(KO, PEP\)/);
  assert.match(progress.textContent, /Valmis/);
  assert.ok(page.state.marketData.get("KO").history.length);
  assert.equal(page.nodes.get("refresh-live").disabled, false);
});

test("startup loads the shared catalog before restoring and refreshing a custom view", async () => {
  const storage = new Map([
    ["stock-radar-explorer-view", JSON.stringify({ listMode: "custom", selected: "MSFT", days: 365 })],
    ["stock-radar-custom-stocks", JSON.stringify([{ symbol: "AAPL" }, { symbol: "MSFT" }])]
  ]);
  const page = loadExplorer({ storage });
  page.run("DIVIDEND_KINGS_LIST.length = 0");
  page.context.fetch = async (url) => ({
    ok: true, json: async () => url === "data/dividend-kings.json" ? page.context.companies : {}
  });
  const requests = [];
  mockQuotes(page, async (symbol) => { requests.push(symbol); return stock(symbol); });
  await page.run("initializeExplorer()");
  assert.equal(page.run("DIVIDEND_KINGS_LIST.length"), page.context.companies.length);
  assert.equal(page.state.selected, "MSFT");
  assert.equal(page.state.days, 365);
  assert.deepEqual(requests, ["MSFT", "AAPL"]);
});

test("manual refresh still reloads history when a background quote request is already running", async () => {
  const page = loadExplorer();
  page.state.marketData.set("KO", { ...stock(), fetchedAt: page.clock.now });
  let resolveQuote;
  const requests = [];
  mockQuotes(page, (symbol, name, cache, interval, range) => {
    requests.push(range);
    if (range === "5d") return new Promise((resolve) => { resolveQuote = resolve; });
    return Promise.resolve(stock());
  });
  const background = page.run("refreshSelectedAndRender(true)");
  const manual = page.run("refreshSelectedAndRender(false)");
  assert.deepEqual(requests, ["5d"]);
  resolveQuote(stock());
  await Promise.all([background, manual]);
  assert.deepEqual(requests, ["5d", "2y"]);
  assert.equal(page.state.selectedRefreshes.size, 0);
  assert.equal(page.state.stockRefreshes.size, 0);
});

test("an unavailable history provider does not trigger a full download on every timer tick", async () => {
  const page = loadExplorer();
  page.state.marketData.set("KO", { ...stock(), fetchedAt: page.clock.now - 16 * 60 * 1000 });
  const requests = [];
  mockQuotes(page, async (symbol, name, cache, interval, range) => {
    requests.push(range);
    return { ...stock(), refreshFailed: true };
  });
  await page.run("refreshSelectedAndRender(true)");
  page.clock.now += 16000;
  await page.run("refreshSelectedAndRender(true)");
  assert.deepEqual(requests, ["2y", "5d"]);
});
