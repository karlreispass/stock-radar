"use strict";

const CUSTOM_STORAGE_KEY = "stock-radar-custom-stocks";
const CUSTOM_SELECTED_KEY = "stock-radar-custom-selected";
const VIEW_STORAGE_KEY = "stock-radar-explorer-view";
const CUSTOM_WORKER_KEY = "stock-radar-worker-url";
const CUSTOM_CACHE_KEY = "stock-radar-live-cache-v5";
const CACHE_TTL_MS = 15 * 1000;
const HISTORY_REFRESH_MS = 15 * 60 * 1000;
const SORT_ORDERS = ["default", "rsi-asc", "rsi-desc", "change-desc", "change-asc", "candidate"];

const DIVIDEND_KINGS_LIST = [];

const DEFAULT_CUSTOM_STOCKS = [
  { symbol: "AAPL", tvSymbol: "NASDAQ:AAPL", name: "Apple", sector: "Tehnoloogia" },
  { symbol: "MSFT", tvSymbol: "NASDAQ:MSFT", name: "Microsoft", sector: "Tehnoloogia" },
  { symbol: "NVDA", tvSymbol: "NASDAQ:NVDA", name: "NVIDIA", sector: "Tehnoloogia" },
  { symbol: "GOOGL", tvSymbol: "NASDAQ:GOOGL", name: "Alphabet", sector: "Tehnoloogia" },
  { symbol: "AMZN", tvSymbol: "NASDAQ:AMZN", name: "Amazon", sector: "Kaubandus / Pilv" },
  { symbol: "KO", tvSymbol: "NYSE:KO", name: "Coca-Cola", sector: "Tarbekaubad" },
  { symbol: "PEP", tvSymbol: "NASDAQ:PEP", name: "PepsiCo", sector: "Tarbekaubad" }
];

const explorerState = {
  listMode: "kings", // "kings" | "custom"
  kingsFilter: "all", // "all" | "low" | "candidate"
  kingsSearch: "",
  sortOrder: "default",
  customStocks: [],
  marketData: new Map(),
  latestQuotes: new Map(),
  intradayData: new Map(),
  fallbackData: new Map(),
  lastPrices: new Map(),
  selected: "KO",
  days: 90,
  intraday: "",
  chartMode: "native",
  tvChartKey: "",
  workerApiUrl: "",
  selectedRefreshes: new Map(),
  stockRefreshes: new Map(),
  historyAttempts: new Map(),
  progress: null,
  loading: false
};

const number = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("et-EE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const dataTimeFormat = new Intl.DateTimeFormat("et-EE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortTimeFormat = new Intl.DateTimeFormat("et-EE", { hour: "2-digit", minute: "2-digit" });
const byId = (id) => document.getElementById(id);

function formatPointLabel(value, isIntraday) {
  if (isIntraday && value.includes("T")) {
    const d = new Date(value);
    if (explorerState.days > 1) {
      return d.toLocaleDateString("et-EE", { day: "2-digit", month: "2-digit" }) + " " + shortTimeFormat.format(d);
    }
    return shortTimeFormat.format(d);
  }
  return dateFormat.format(new Date(value));
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function parseSymbolInput(rawInput) {
  const cleaned = String(rawInput || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^(?:[A-Z0-9]{1,12}:)?[A-Z0-9._-]{1,12}$/.test(cleaned)) {
    throw new Error("Sümbol võib sisaldada tähti, numbreid, punkti, sidekriipsu ja valikulist börsi eesliidet (nt AAPL või NASDAQ:AAPL).");
  }
  const parts = cleaned.split(":");
  const symbol = parts[parts.length - 1];
  const tvSymbol = parts.length > 1 ? cleaned : symbol;
  return { symbol, tvSymbol };
}

function calculateRsi(prices, period = 14) {
  const result = new Array(prices.length).fill(null);
  if (prices.length <= period) return result;
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 0; i < period; i++) {
    averageGain += Math.max(changes[i], 0);
    averageLoss += Math.max(-changes[i], 0);
  }
  averageGain /= period;
  averageLoss /= period;

  const computeValue = () => {
    if (averageGain === 0 && averageLoss === 0) return 50.0;
    if (averageLoss === 0) return 100.0;
    return 100 - 100 / (1 + averageGain / averageLoss);
  };

  result[period] = computeValue();
  for (let index = period + 1; index < prices.length; index++) {
    const change = changes[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = computeValue();
  }
  return result;
}

function signalFor(current) {
  if (current === null || current === undefined) return { label: "Andmeid vähe", kind: "", description: "RSI arvutamiseks on vaja rohkem ajalugu." };
  if (current < 30) return { label: "RSI alla 30", kind: "low", description: "RSI on alla 30. Tugev müügisurve võib jätkuda; see ei kinnita hinnapõhja." };
  if (current > 70) return { label: "RSI üle 70", kind: "high", description: "RSI on üle 70. Tugev ostuhoog võib püsida; see ei ole automaatne müügisignaal." };
  if (current < 40) return { label: "Jälgimisalas", kind: "watch", description: "RSI on alla 40. Võimaliku taastumise hindamiseks vaata ka hinna ja RSI suunda." };
  return { label: "Neutraalne", kind: "", description: "RSI on vahemikus 40–70." };
}

function directionText(change, unit) {
  if (change === null || !Number.isFinite(change)) return "Andmeid vähe";
  const direction = change > 0 ? "Tõuseb" : change < 0 ? "Langeb" : "Muutumatu";
  return direction + " " + (change > 0 ? "+" : "") + number.format(change) + unit;
}

function trendCell(change, unit) {
  const cell = element("td", "trend-cell");
  cell.append(element("strong", change > 0 ? "positive" : change < 0 ? "negative" : "", directionText(change, unit)));
  cell.append(element("small", "", "5 kauplemispäeva"));
  return cell;
}

function activeListItems() {
  return explorerState.listMode === "kings" ? DIVIDEND_KINGS_LIST : explorerState.customStocks;
}

function findItemBySymbol(symbol) {
  return DIVIDEND_KINGS_LIST.find((s) => s.symbol === symbol)
    || explorerState.customStocks.find((s) => s.symbol === symbol);
}

function loadSavedStocks() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => {
          const { symbol, tvSymbol } = parseSymbolInput(item.tvSymbol || item.symbol);
          return {
            symbol,
            tvSymbol,
            name: (item.name || "").trim() || symbol,
            sector: item.sector || "USA börs"
          };
        });
      }
    }
  } catch {
    // Ignore storage read errors and use defaults.
  }
  return DEFAULT_CUSTOM_STOCKS.map((item) => ({ ...item }));
}

function saveView() {
  const { listMode, selected, days, intraday, chartMode, sortOrder, kingsFilter, kingsSearch } = explorerState;
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ listMode, selected, days, intraday, chartMode, sortOrder, kingsFilter, kingsSearch }));
  } catch {
    // Navigation still works when storage is unavailable.
  }
}

function restoreView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) || "{}");
    if (["kings", "custom"].includes(saved.listMode)) explorerState.listMode = saved.listMode;
    if (["native", "tradingview"].includes(saved.chartMode)) explorerState.chartMode = saved.chartMode;
    if (SORT_ORDERS.includes(saved.sortOrder)) explorerState.sortOrder = saved.sortOrder;
    if (["all", "low", "candidate"].includes(saved.kingsFilter)) explorerState.kingsFilter = saved.kingsFilter;
    if (typeof saved.kingsSearch === "string") explorerState.kingsSearch = saved.kingsSearch.slice(0, 100);
    if ([30, 90, 365].includes(saved.days) && !saved.intraday) explorerState.days = saved.days;
    if ((saved.intraday === "1m" && saved.days === 1) || (saved.intraday === "5m" && saved.days === 5)) {
      explorerState.days = saved.days;
      explorerState.intraday = saved.intraday;
    }
    const selected = saved.selected || localStorage.getItem(CUSTOM_SELECTED_KEY);
    if (selected) {
      explorerState.selected = activeListItems().some((item) => item.symbol === selected)
        ? selected : activeListItems()[0]?.symbol || "";
    }
  } catch {
    // Invalid saved choices use the defaults.
  }
  if (!activeListItems().some((item) => item.symbol === explorerState.selected)) {
    explorerState.selected = activeListItems()[0]?.symbol || "";
  }
}

function updatePressedButtons(id, attribute, value) {
  for (const button of byId(id).querySelectorAll("button")) {
    const active = button.dataset[attribute] === String(value);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function syncViewControls() {
  updatePressedButtons("list-mode-controls", "list", explorerState.listMode);
  updatePressedButtons("chart-mode-controls", "mode", explorerState.chartMode);
  updatePressedButtons("ranges", "days", explorerState.days);
  updatePressedButtons("kings-filters", "filter", explorerState.kingsFilter);
  byId("sort-stocks").value = explorerState.sortOrder;
  byId("kings-search").value = explorerState.kingsSearch;
}

function saveStocks() {
  saveView();
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(explorerState.customStocks));
    localStorage.setItem(CUSTOM_SELECTED_KEY, explorerState.selected);
  } catch {
    // Working in-memory when browser storage is blocked.
  }
}

function readSessionCache(cacheKey, maxAge = CACHE_TTL_MS, minimumPoints = 16) {
  try {
    const all = JSON.parse(sessionStorage.getItem(CUSTOM_CACHE_KEY) || "{}");
    const entry = all[cacheKey];
    if (entry && Date.now() - entry.savedAt < maxAge && entry.data?.history?.length >= minimumPoints) {
      return entry.data;
    }
  } catch {
    // Ignore cache errors.
  }
  return null;
}

function writeSessionCache(cacheKey, data) {
  try {
    const all = JSON.parse(sessionStorage.getItem(CUSTOM_CACHE_KEY) || "{}");
    all[cacheKey] = { savedAt: Date.now(), data };
    sessionStorage.setItem(CUSTOM_CACHE_KEY, JSON.stringify(all));
  } catch {
    // Ignore cache write errors.
  }
}

function showFeedback(message, isError = false) {
  const notice = byId("custom-feedback");
  if (!message) {
    notice.hidden = true;
    notice.textContent = "";
    return;
  }
  notice.hidden = false;
  notice.className = "section-caption custom-feedback" + (isError ? " negative" : " positive");
  notice.textContent = message;
}

function buildStockObject(requestedSymbol, customName, sourceLabel, rows, liveTimeIso, minimumPoints = 16) {
  if (rows.length < minimumPoints) {
    throw new Error("Aktsial " + requestedSymbol + " on RSI jaoks liiga vähe punkte.");
  }
  const rsiValues = calculateRsi(rows.map((r) => r.close), 14);
  const history = rows.map((row, idx) => ({
    ...row,
    rsi: rsiValues[idx] !== null ? Number(rsiValues[idx].toFixed(4)) : null
  }));

  const kingMeta = DIVIDEND_KINGS_LIST.find((k) => k.symbol === requestedSymbol);
  return {
    symbol: requestedSymbol,
    name: customName || kingMeta?.name || requestedSymbol,
    sector: kingMeta ? kingMeta.sector : sourceLabel,
    streak_years: kingMeta?.streakYears ?? null,
    liveTime: liveTimeIso || rows.at(-1).date,
    sourceMode: "provider",
    isRealtime: false,
    history
  };
}

function parseYahooChartResponse(text, requestedSymbol, customName, isIntraday = false, minimumPoints = 16) {
  const json = JSON.parse(text);
  const result = json?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp) || !result.indicators?.quote?.[0]) {
    throw new Error("Yahoo Finance vastus puudub.");
  }
  const meta = result.meta || {};
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close || [];
  const adjCloses = isIntraday ? closes : (result.indicators.adjclose?.[0]?.adjclose || closes);

  const byKey = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const rawClose = closes[i];
    const adjClose = adjCloses[i] ?? rawClose;
    if (!Number.isFinite(rawClose) || rawClose <= 0 || !Number.isFinite(adjClose) || adjClose <= 0) continue;
    const key = isIntraday
      ? new Date(timestamps[i] * 1000).toISOString()
      : new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    byKey.set(key, {
      date: key,
      close: Number(adjClose.toFixed(4)),
      quote_close: Number(rawClose.toFixed(4))
    });
  }

  if (Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0 && Number.isFinite(meta.regularMarketTime)) {
    const liveKey = isIntraday
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
    const livePrice = Number(meta.regularMarketPrice.toFixed(4));
    byKey.set(liveKey, {
      date: liveKey,
      close: livePrice,
      quote_close: livePrice
    });
  }

  const rows = Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date));
  const exchange = meta.exchangeName || meta.fullExchangeName || "USA börs";
  const resolvedName = customName || meta.shortName || meta.longName || requestedSymbol;
  const liveTimeIso = Number.isFinite(meta.regularMarketTime)
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : rows.at(-1)?.date;

  return buildStockObject(requestedSymbol, resolvedName, exchange, rows, liveTimeIso, minimumPoints);
}

function parseCnbcBarsResponse(text, requestedSymbol, customName, isIntraday = false, minimumPoints = 16) {
  const json = JSON.parse(text);
  const bars = json?.barData?.priceBars || json?.barData?.bars;
  if (!Array.isArray(bars) || bars.length < minimumPoints) {
    throw new Error("CNBC hinnaajalugu puudub.");
  }
  const byKey = new Map();
  for (const bar of bars) {
    const close = Number(bar.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    let key = "";
    if (bar.tradeTimeinMills) {
      const iso = new Date(Number(bar.tradeTimeinMills)).toISOString();
      key = isIntraday ? iso : iso.slice(0, 10);
    } else if (typeof bar.tradeTime === "string" && bar.tradeTime.length >= 8) {
      const d = bar.tradeTime.slice(0, 4) + "-" + bar.tradeTime.slice(4, 6) + "-" + bar.tradeTime.slice(6, 8);
      if (isIntraday && bar.tradeTime.length >= 14) {
        key = d + "T" + bar.tradeTime.slice(8, 10) + ":" + bar.tradeTime.slice(10, 12) + ":" + bar.tradeTime.slice(12, 14) + "Z";
      } else {
        key = d;
      }
    }
    if (!key) continue;
    const rounded = Number(close.toFixed(4));
    byKey.set(key, { date: key, close: rounded, quote_close: rounded });
  }
  const rows = Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date));
  return buildStockObject(requestedSymbol, customName || requestedSymbol, "USA börs", rows, undefined, minimumPoints);
}

function formatCnbcTimestamp(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return dateObj.getUTCFullYear()
    + pad(dateObj.getUTCMonth() + 1)
    + pad(dateObj.getUTCDate())
    + "235959";
}

async function fetchViaProvider(provider, symbol, customName, isIntraday, minimumPoints) {
  const response = await fetch(provider.url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8500)
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  let rawText = await response.text();
  if (provider.unwrapAllOrigins) {
    const wrapper = JSON.parse(rawText);
    rawText = wrapper.contents || "";
  }
  return provider.parse(rawText, symbol, customName, isIntraday, minimumPoints);
}

async function fetchYahooSymbol(symbol, customName, useCache = true, interval = "1d", range = "2y", minimumPoints = 16) {
  const isIntraday = interval !== "1d";
  const cacheKey = symbol + ":" + interval + ":" + range;
  if (useCache) {
    const maxAge = interval === "1d" && range === "2y" ? HISTORY_REFRESH_MS : CACHE_TTL_MS;
    const cached = readSessionCache(cacheKey, maxAge, minimumPoints);
    if (cached) {
      if (customName) cached.name = customName;
      return cached;
    }
  }

  const yahooSymbol = symbol.replace(".", "-");
  const yahooUrl = "https://query2.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(yahooSymbol)
    + "?interval=" + interval + "&range=" + range + "&includeAdjustedClose=true";

  const now = new Date();
  const startDays = isIntraday ? (range === "1d" ? 4 : 7) : range === "5d" ? 10 : 735;
  const startObj = new Date(now.getTime() - startDays * 86400000);
  const cnbcInterval = interval === "1m" ? "1M" : interval === "5m" ? "5M" : "1D";
  const cnbcUrl = "https://ts-api.cnbc.com/harmony/app/bars/"
    + encodeURIComponent(symbol)
    + "/" + cnbcInterval + "/" + formatCnbcTimestamp(startObj)
    + "/" + formatCnbcTimestamp(now)
    + "/adjusted/EST5EDT.json";

  const providers = [];
  if (explorerState.workerApiUrl) {
    providers.push({
      url: explorerState.workerApiUrl + "/v1/chart?symbol=" + encodeURIComponent(yahooSymbol) + "&interval=" + interval + "&range=" + range,
      unwrapAllOrigins: false,
      parse: parseYahooChartResponse
    });
  }

  providers.push(
    {
      url: "https://api.allorigins.win/get?url=" + encodeURIComponent(cnbcUrl),
      unwrapAllOrigins: true,
      parse: parseCnbcBarsResponse
    },
    {
      url: "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(cnbcUrl),
      unwrapAllOrigins: false,
      parse: parseCnbcBarsResponse
    },
    {
      url: "https://api.allorigins.win/get?url=" + encodeURIComponent(yahooUrl),
      unwrapAllOrigins: true,
      parse: parseYahooChartResponse
    },
    {
      url: "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(yahooUrl),
      unwrapAllOrigins: false,
      parse: parseYahooChartResponse
    }
  );

  try {
    const firstWave = providers.slice(0, 2).map((p) => fetchViaProvider(p, symbol, customName, isIntraday, minimumPoints));
    const parsed = await Promise.any(firstWave);
    parsed.fetchedAt = Date.now();
    writeSessionCache(cacheKey, parsed);
    return parsed;
  } catch {
    try {
      const secondWave = providers.slice(2).map((p) => fetchViaProvider(p, symbol, customName, isIntraday, minimumPoints));
      const parsed = await Promise.any(secondWave);
      parsed.fetchedAt = Date.now();
      writeSessionCache(cacheKey, parsed);
      return parsed;
    } catch {
      const currentStock = explorerState.marketData.get(symbol);
      const availableStock = currentStock?.history?.length ? currentStock : explorerState.fallbackData.get(symbol);
      if (!isIntraday && availableStock) {
        // A failed refresh must not replace newer in-memory prices with an older file.
        const fallback = structuredClone(availableStock);
        fallback.refreshFailed = true;
        if (customName) fallback.name = customName;
        return fallback;
      }
      throw new Error("Ootab andmeühendust (vaata TradingView vaadet)");
    }
  }
}

async function initConfigAndFallback() {
  try {
    const savedWorker = localStorage.getItem(CUSTOM_WORKER_KEY);
    if (savedWorker && savedWorker.startsWith("https://")) {
      explorerState.workerApiUrl = new URL(savedWorker).origin;
    }
  } catch {}
  try {
    const cfgResp = await fetch("profile-config.json", { cache: "no-store" });
    if (cfgResp.ok) {
      const cfg = await cfgResp.json();
      if (cfg.api_url && cfg.api_url.startsWith("https://")) {
        explorerState.workerApiUrl = new URL(cfg.api_url).origin;
      }
    }
  } catch {
    // Ignore optional profile-config.json failure.
  }
  const workerForm = byId("worker-url-form");
  if (workerForm) {
    workerForm.hidden = Boolean(explorerState.workerApiUrl);
    byId("worker-url-input").value = explorerState.workerApiUrl || "";
  }

  await loadPublishedSnapshots();
}

let snapshotCheckedAt = Date.now();
let snapshotLoading = false;

async function loadPublishedSnapshots() {
  if (snapshotLoading) return;
  snapshotLoading = true;
  snapshotCheckedAt = Date.now();
  try {
    for (const file of ["data/kings.json", "data/stocks.json"]) {
      try {
        const snapResp = await fetch(file, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!snapResp.ok) continue;
        const snap = await snapResp.json();
        if (!Array.isArray(snap.stocks)) continue;
        for (const stock of snap.stocks) {
          const kingMeta = DIVIDEND_KINGS_LIST.find((k) => k.symbol === stock.symbol);
          const enriched = {
            ...stock,
            streak_years: stock.streak_years ?? kingMeta?.streakYears ?? null,
            sourceMode: snap.mode === "demo" ? "demo" : "snapshot",
            liveTime: stock.quote?.as_of || stock.history?.at(-1)?.date,
            isRealtime: false
          };
          explorerState.fallbackData.set(stock.symbol, enriched);
          const current = explorerState.marketData.get(stock.symbol);
          const currentTime = Date.parse(current?.liveTime || current?.history?.at(-1)?.date || "");
          if (!current || (["snapshot", "demo"].includes(current.sourceMode) && Date.parse(enriched.liveTime) >= currentTime)) {
            explorerState.marketData.set(stock.symbol, structuredClone(enriched));
            const latestQuote = explorerState.latestQuotes.get(stock.symbol);
            if (latestQuote && ["snapshot", "demo"].includes(latestQuote.sourceMode)) {
              explorerState.latestQuotes.delete(stock.symbol);
            }
          }
        }
      } catch {
        // Keep the last usable snapshot when publication or network access fails.
      }
    }
  } finally {
    snapshotLoading = false;
  }
}

async function loadKingsList() {
  const response = await fetch("data/dividend-kings.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Ettevõtete nimekirja laadimine ebaõnnestus. Uuenda lehte.");
  const companies = await response.json();
  if (!Array.isArray(companies) || companies.length === 0 || companies.some((company) =>
    !company || typeof company.symbol !== "string" || typeof company.name !== "string"
    || typeof company.sector !== "string" || typeof company.tvSymbol !== "string"
    || !Number.isInteger(company.streakYears) || company.streakYears < 50)
    || new Set(companies.map((company) => company.symbol)).size !== companies.length) {
    throw new Error("Ettevõtete nimekiri on vigane.");
  }
  DIVIDEND_KINGS_LIST.splice(0, DIVIDEND_KINGS_LIST.length, ...companies);
}

async function initializeExplorer() {
  await loadKingsList();
  restoreView();
  syncViewControls();
  await initConfigAndFallback();
  await refreshAllLiveStocks(true);
}

function showInitializationError(error) {
  const notice = byId("live-notice");
  notice.className = "notice error";
  notice.textContent = error.message || "Andmete laadimine ebaõnnestus. Uuenda lehte.";
}

function updateListModeUI() {
  syncViewControls();
  const isKings = explorerState.listMode === "kings";
  byId("list-eyebrow").textContent = isKings ? "50+ AASTAT DIVIDENDI KASVU" : "KOHANDATAV JÄLGIMISNIMEKIRI";
  byId("list-heading").textContent = isKings ? "USA Dividend Kings (" + DIVIDEND_KINGS_LIST.length + ")" : "Sinu vabalt valitud aktsiad";
  const kingsButton = byId("list-mode-controls").querySelector('[data-list="kings"]');
  if (kingsButton) kingsButton.textContent = "Dividend Kings (" + DIVIDEND_KINGS_LIST.length + ")";
  byId("list-caption").textContent = isKings
    ? "Ettevõtted, mis on suurendanud dividendi vähemalt 50 aastat järjest. Klõpsa aktsial graafiku ja RSI detailide vaatamiseks."
    : "Sisesta mis tahes USA aktsia sümbol (nt AAPL, NVDA, MSFT, TSLA). Valikud salvestuvad sellesse brauserisse.";
  byId("kings-filter-bar").hidden = !isKings;
  byId("custom-stock-form").hidden = isKings;
  byId("reset-watchlist").hidden = isKings;
  byId("metric-total-label").textContent = isKings ? "Dividend Kings nimekirjas" : "Jälgitavad aktsiad";
  byId("metric-total-sub").textContent = isKings ? "50+ aastat järjestikust dividendi kasvu" : "Sinu vabalt valitud nimekiri";

  const headRow = byId("table-head-row");
  headRow.replaceChildren();
  const headers = isKings
    ? ["Ettevõte", "Dividendi kasv", "Hind / päevamuutus", "RSI", "Hinna suund", "RSI suund", "Hinnang"]
    : ["Ettevõte", "Hind / päevamuutus", "RSI", "Hinna suund", "RSI suund", "Hinnang", "Toiming"];
  for (const h of headers) {
    headRow.append(element("th", "", h));
  }
}

function dataSourceLabel(stock) {
  if (stock.sourceMode === "demo") return "Näidisandmed";
  if (stock.sourceMode === "snapshot") return "Salvestatud andmed";
  return "Teenusest laaditud · võimalik viivitus";
}

function renderOverview() {
  const list = activeListItems();
  const loadedStocks = list
    .map((item) => explorerState.marketData.get(item.symbol))
    .filter((stock) => stock && Array.isArray(stock.history) && stock.history.length > 0);

  byId("custom-stock-count").textContent = list.length;
  if (loadedStocks.length === 0) {
    byId("custom-low-count").textContent = "—";
    byId("custom-recovery-count").textContent = "—";
    byId("custom-data-date").textContent = "—";
    byId("custom-updated-at").textContent = "Andmed puuduvad";
    return;
  }

  byId("custom-low-count").textContent = loadedStocks.filter((stock) => Number.isFinite(stock.history.at(-1).rsi) && stock.history.at(-1).rsi < 40).length;
  byId("custom-recovery-count").textContent = loadedStocks.filter((stock) => analyzeStock(stock).label === "Võimalik ostukandidaat").length;

  const dates = loadedStocks.map((stock) => stock.history.at(-1).date.slice(0, 10)).sort();
  byId("custom-data-date").textContent = dateFormat.format(new Date(dates.at(-1)));
  const dataTimes = loadedStocks.map((stock) => stock.liveTime || stock.history.at(-1).date)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const oldestTime = dataTimes[0];
  const sourceLabels = [...new Set(loadedStocks.map(dataSourceLabel))];
  byId("custom-updated-at").textContent = (oldestTime
    ? "Vanim andmeaeg " + (oldestTime.includes("T") ? dataTimeFormat : dateFormat).format(new Date(oldestTime))
    : "Andmeaeg teadmata") + " · " + sourceLabels.join(" / ");

  const notice = byId("live-notice");
  notice.className = "notice live";
  notice.textContent = explorerState.listMode === "kings"
    ? "DIVIDEND KINGS (50+ AASTAT) · Nimekirjas on " + DIVIDEND_KINGS_LIST.length + " USA ettevõtet koos viimase hinna ja RSI (14) signaalidega."
    : "MINU VABA VALIK · Lisa mis tahes USA börsisümbol ning vaata viimast saadaolevat hinda, RSI (14) ja TradingView graafikut.";
}

function filteredListItems() {
  const list = activeListItems();
  if (explorerState.listMode !== "kings") return list;

  const q = explorerState.kingsSearch.trim().toLowerCase();
  return list.filter((item) => {
    if (q) {
      const hay = (item.symbol + " " + item.name + " " + item.sector).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (explorerState.kingsFilter === "all") return true;
    const stock = explorerState.marketData.get(item.symbol);
    if (!stock || !stock.history?.length) return false;
    if (explorerState.kingsFilter === "low") {
      return stock.history.at(-1).rsi !== null && stock.history.at(-1).rsi < 40;
    }
    if (explorerState.kingsFilter === "candidate") {
      return analyzeStock(stock).label === "Võimalik ostukandidaat";
    }
    return true;
  });
}

function quoteSummary(symbol) {
  const stock = explorerState.latestQuotes.get(symbol) || explorerState.marketData.get(symbol);
  const latest = stock?.history?.at(-1);
  const previous = stock?.quote && stock.quote.date > latest?.date ? latest : stock?.history?.at(-2);
  const price = stock?.quote?.price ?? latest?.quote_close ?? latest?.close;
  const previousPrice = previous?.quote_close ?? previous?.close;
  const change = Number.isFinite(price) && previousPrice > 0 ? (price / previousPrice - 1) * 100 : null;
  return { price, change, time: stock?.quote?.as_of || stock?.liveTime || latest?.date, source: stock };
}

function sortedListItems() {
  const items = filteredListItems();
  if (explorerState.sortOrder === "default") return items;
  const values = new Map(items.map((item) => {
    const stock = explorerState.marketData.get(item.symbol);
    let value = stock?.history?.at(-1)?.rsi;
    if (explorerState.sortOrder.startsWith("change")) value = quoteSummary(item.symbol).change;
    if (explorerState.sortOrder === "candidate") value = stock?.history?.length ? Number(analyzeStock(stock).candidate) : null;
    return [item.symbol, value];
  }));
  const direction = explorerState.sortOrder.endsWith("asc") ? 1 : -1;
  return [...items].sort((first, second) => {
    const firstValue = values.get(first.symbol);
    const secondValue = values.get(second.symbol);
    if (!Number.isFinite(firstValue)) return Number.isFinite(secondValue) ? 1 : 0;
    if (!Number.isFinite(secondValue)) return -1;
    return (firstValue - secondValue) * direction;
  });
}

function renderCustomList() {
  updateListModeUI();
  const tbody = byId("custom-stock-list");
  tbody.replaceChildren();
  const isKings = explorerState.listMode === "kings";
  const items = sortedListItems();

  if (items.length === 0) {
    const emptyRow = element("tr");
    const cell = element("td", "", "Valitud filtrile ei vasta praegu ükski aktsia.");
    cell.colSpan = 7;
    emptyRow.append(cell);
    tbody.append(emptyRow);
    return;
  }

  for (const item of items) {
    const stock = explorerState.marketData.get(item.symbol);
    const isSelected = item.symbol === explorerState.selected;
    const row = element("tr", "stock-row" + (isSelected ? " selected" : ""));

    const nameCell = element("td");
    const button = element("button", "ticker-button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(isSelected));
    button.setAttribute("aria-label", "Vaata aktsiat " + (stock?.name || item.name));
    const icon = element("span", "company-icon", item.symbol.slice(0, 5));
    icon.setAttribute("aria-hidden", "true");
    const nameWrap = element("span");
    nameWrap.append(
      element("strong", "", stock?.name || item.name),
      element("small", "", item.symbol + " · " + (item.sector || stock?.sector || "USA börs"))
    );
    button.append(icon, nameWrap);
    button.addEventListener("click", () => {
      explorerState.selected = item.symbol;
      saveStocks();
      showFeedback("");
      renderCustomList();
      refreshSelectedAndRender(true);
    });
    nameCell.append(button);
    row.append(nameCell);

    if (isKings) {
      const streakCell = element("td");
      streakCell.append(element("span", "streak-badge", (item.streakYears || stock?.streak_years || 50) + " a järjest"));
      row.append(streakCell);
    }

    if (stock && stock.history?.length >= 2) {
      const latest = stock.history.at(-1);
      const { price, change, time } = quoteSummary(item.symbol);
      const signal = signalFor(latest.rsi);
      const analysis = analyzeStock(stock);

      const prevSeenPrice = explorerState.lastPrices.get(item.symbol);
      let flashClass = "";
      if (prevSeenPrice !== undefined && prevSeenPrice !== price) {
        flashClass = price > prevSeenPrice ? " tick-up" : " tick-down";
      }
      explorerState.lastPrices.set(item.symbol, price);

      const priceCell = element("td", "price-cell" + flashClass);
      priceCell.append(
        element("strong", "", "$" + number.format(price)),
        element("small", change > 0 ? "positive" : change < 0 ? "negative" : "", change === null ? "—" : (change >= 0 ? "+" : "") + number.format(change) + "%")
      );
      priceCell.title = time ? "Hinna aeg: " + (time.includes("T") ? dataTimeFormat : dateFormat).format(new Date(time)) : "Andmeaeg teadmata";

      const rsiCell = element("td", "rsi-number" + (signal.kind === "low" ? " positive" : ""), latest.rsi !== null ? decimal.format(latest.rsi) : "—");
      rsiCell.append(element("small", "rsi-status", signal.label));

      const signalCell = element("td");
      signalCell.append(element("span", "badge " + analysis.kind, analysis.label));
      signalCell.title = analysis.description;

      row.append(
        priceCell,
        rsiCell,
        trendCell(analysis.priceChange, "%"),
        trendCell(analysis.rsiChange, " p"),
        signalCell
      );
    } else {
      const statusText = stock?.error ? stock.error : "Laadin hinda ja RSI-d…";
      const statusCell = element("td", "", statusText);
      statusCell.colSpan = 5;
      row.append(statusCell);
    }

    if (!isKings) {
      const actionCell = element("td");
      const removeButton = element("button", "secondary small-button", "Eemalda");
      removeButton.type = "button";
      removeButton.disabled = explorerState.customStocks.length <= 1;
      removeButton.setAttribute("aria-label", "Eemalda " + item.symbol);
      removeButton.addEventListener("click", () => {
        if (explorerState.customStocks.length <= 1) return;
        explorerState.customStocks = explorerState.customStocks.filter((s) => s.symbol !== item.symbol);
        if (explorerState.selected === item.symbol) {
          explorerState.selected = explorerState.customStocks[0].symbol;
        }
        saveStocks();
        showFeedback(item.symbol + " eemaldati nimekirjast.");
        renderOverview();
        renderCustomList();
        renderDetail();
      });
      actionCell.append(removeButton);
      row.append(actionCell);
    }

    tbody.append(row);
  }
}

const svgNS = "http://www.w3.org/2000/svg";
function svgElement(tag, attributes, text) {
  const node = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChart(containerId, points, field, isIntraday = false) {
  const isRsi = field === "rsi";
  const width = 1100, height = isRsi ? 150 : 230;
  const left = 10, right = 70, top = 16, bottom = 30;
  const valid = points.filter((point) => point[field] !== null);
  const container = byId(containerId);
  container.replaceChildren();
  if (valid.length < 2) {
    container.textContent = "Graafiku jaoks pole piisavalt andmeid.";
    return;
  }
  const values = valid.map((point) => point[field]);
  if (!isRsi) {
    for (const key of ["average", "average50", "average200"]) {
      values.push(...points.filter((point) => Number.isFinite(point[key])).map((point) => point[key]));
    }
  }
  const minimum = isRsi ? 0 : Math.min(...values) * 0.992;
  const maximum = isRsi ? 100 : Math.max(...values) * 1.008;
  const span = maximum - minimum || 1;
  const x = (index) => left + index / (points.length - 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / span * (height - top - bottom);
  const svg = svgElement("svg", {
    viewBox: "0 0 " + width + " " + height,
    role: "img",
    "aria-label": isRsi
      ? "RSI graafik, piirid 30, 40 ja 70."
      : "Hinna ja liikuvate keskmiste graafik."
  });
  const levels = isRsi ? [30, 40, 70] : [minimum, (minimum + maximum) / 2, maximum];
  if (isRsi) {
    svg.append(svgElement("rect", { x: left, y: y(40), width: width - left - right, height: y(0) - y(40), fill: "var(--green)", opacity: ".035" }));
  }
  for (const level of levels) {
    svg.append(svgElement("line", { x1: left, y1: y(level), x2: width - right + 4, y2: y(level), stroke: "var(--chart-grid)", "stroke-dasharray": isRsi ? "5 5" : "2 6" }));
    svg.append(svgElement("text", { x: width - right + 15, y: y(level) + 4, fill: "var(--muted)", "font-size": 11 }, isRsi ? String(level) : number.format(level)));
  }
  const coordinates = [];
  points.forEach((point, index) => {
    if (point[field] !== null) coordinates.push([x(index), y(point[field])]);
  });
  const path = coordinates.map(([px, py], index) => (index ? "L" : "M") + px.toFixed(2) + "," + py.toFixed(2)).join(" ");
  if (!isRsi) {
    const base = height - bottom;
    svg.append(svgElement("path", { d: path + " L" + coordinates.at(-1)[0] + "," + base + " L" + coordinates[0][0] + "," + base + " Z", fill: "var(--green)", opacity: ".055" }));
  }
  svg.append(svgElement("path", { d: path, fill: "none", stroke: isRsi ? "var(--rsi-line)" : "var(--green)", "stroke-width": 2.2, "stroke-linejoin": "round" }));
  if (!isRsi) {
    const averagePath = points.map((point, index) => ({ point, index }))
      .filter(({ point }) => point.average !== null)
      .map(({ point, index }, pathIndex) => (pathIndex ? "L" : "M") + x(index).toFixed(2) + "," + y(point.average).toFixed(2)).join(" ");
    if (averagePath) {
      svg.append(svgElement("path", { d: averagePath, fill: "none", stroke: "var(--amber)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
    }
    for (const [key, color] of [["average50", "var(--trend50)"], ["average200", "var(--trend200)"]]) {
      const trendPath = points.map((point, index) => ({ point, index })).filter(({ point }) => Number.isFinite(point[key]))
        .map(({ point, index }, pathIndex) => (pathIndex ? "L" : "M") + x(index).toFixed(2) + "," + y(point[key]).toFixed(2)).join(" ");
      if (trendPath) svg.append(svgElement("path", { d: trendPath, fill: "none", stroke: color, "stroke-width": 1.8 }));
    }
  }
  points.forEach((point, index) => {
    if (point[field] === null) return;
    const signal = signalFor(point.rsi);
    if (isRsi && ["low", "watch"].includes(signal.kind)) {
      const marker = svgElement("circle", { cx: x(index), cy: y(point.rsi), r: 3, fill: signal.kind === "low" ? "var(--green)" : "var(--amber)" });
      marker.append(svgElement("title", {}, formatPointLabel(point.date, isIntraday) + " · RSI " + decimal.format(point.rsi) + " · " + signal.label));
      svg.append(marker);
    }
  });
  if (coordinates.length > 0) {
    const [lastX, lastY] = coordinates.at(-1);
    svg.append(svgElement("circle", { cx: lastX, cy: lastY, r: 4.5, fill: "var(--green)" }));
  }
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const index = Math.round((points.length - 1) * fraction);
    const rawDate = points[index].date;
    const label = isIntraday
      ? formatPointLabel(rawDate, true)
      : rawDate.slice(5, 10).split("-").reverse().join(".");
    svg.append(svgElement("text", {
      x: x(index),
      y: height - 5,
      fill: "var(--muted)",
      "font-size": 10,
      "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
    }, label));
  }
  container.append(svg);
}

function renderTradingViewWidget(item, force = false) {
  const container = byId("explorer-chart");
  const marketSymbol = item.tvSymbol || item.symbol;
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const tvInterval = explorerState.intraday === "1m" ? "1" : explorerState.intraday === "5m" ? "5" : "D";
  const key = marketSymbol + ":" + tvInterval + ":" + theme;
  if (!force && explorerState.tvChartKey === key) return;
  explorerState.tvChartKey = key;

  const wrapper = document.createElement("div");
  wrapper.className = "tradingview-widget-container";
  const chart = document.createElement("div");
  chart.className = "tradingview-widget-container__widget";
  const credit = document.createElement("div");
  credit.className = "tradingview-widget-copyright";
  const link = document.createElement("a");
  link.href = "https://www.tradingview.com/symbols/" + marketSymbol.replace(":", "-") + "/";
  link.target = "_blank";
  link.rel = "noopener nofollow";
  link.textContent = item.symbol + " graafik TradingView’s";
  credit.append(link);
  wrapper.append(chart, credit);
  container.replaceChildren(wrapper);

  const script = document.createElement("script");
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.type = "text/javascript";
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: marketSymbol,
    interval: tvInterval,
    timezone: "exchange",
    theme,
    style: "1",
    locale: "en",
    withdateranges: true,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    save_image: false,
    studies: ["RSI@tv-basicstudies"],
    calendar: false,
    support_host: "https://www.tradingview.com"
  });
  wrapper.append(script);
}

function clearDetailData() {
  for (const id of ["detail-price", "detail-rsi", "price-trend", "rsi-trend", "average-position",
    "average-50", "average-200", "assessment-title", "rsi-range"]) {
    byId(id).textContent = "—";
  }
  byId("signal-description").textContent = "Selle aktsia analüüsiks pole veel andmeid.";
  byId("latest-quote").textContent = "";
  for (const id of ["price-chart", "rsi-chart", "history-list"]) {
    byId(id).replaceChildren();
  }
}

function renderDetail() {
  const item = findItemBySymbol(explorerState.selected) || activeListItems()[0];
  if (!item) return;
  const dailyStock = explorerState.marketData.get(item.symbol);
  const intradayStock = explorerState.intradayData.get(item.symbol + ":" + explorerState.intraday);
  const isIntraday = Boolean(explorerState.intraday && intradayStock?.history?.length);
  const activeStock = isIntraday ? intradayStock : dailyStock;

  const hasHistory = Boolean(activeStock && activeStock.history && activeStock.history.length >= 2);
  // If native history is not yet available for an uncached stock, automatically show TradingView so the chart is never blank!
  const effectiveNative = explorerState.chartMode === "native" && hasHistory;

  byId("native-chart-section").hidden = !effectiveNative;
  byId("tv-chart-section").hidden = effectiveNative;
  byId("ranges").hidden = !effectiveNative;

  if (!effectiveNative) {
    renderTradingViewWidget(item);
  }

  const streakSuffix = item.streakYears ? " · Dividendi kasv " + item.streakYears + " a järjest" : "";
  if (!hasHistory) {
    clearDetailData();
    byId("explorer-title").textContent = (item.name || item.symbol) + " · " + item.symbol;
    byId("explorer-subtitle").textContent = (item.sector || "USA börs") + streakSuffix + " · TradingView graafik; analüüsiandmed puuduvad";
    return;
  }

  const latest = activeStock.history.at(-1);
  let points;
  if (isIntraday && activeStock.history[0].date.includes("T")) {
    const maxPoints = explorerState.intraday === "1m" ? 240 : 300;
    const allWithAvg = activeStock.history.map((point, index) => ({
      ...point,
      previousRsi: activeStock.history[index - 1]?.rsi ?? null,
      average: movingAverage(activeStock.history, index),
      average50: movingAverage(activeStock.history, index, 50),
      average200: movingAverage(activeStock.history, index, 200)
    }));
    points = allWithAvg.slice(-maxPoints);
  } else {
    const cutoff = new Date(latest.date.slice(0, 10) + "T00:00:00Z");
    cutoff.setUTCDate(cutoff.getUTCDate() - explorerState.days);
    points = activeStock.history.map((point, index) => ({
      ...point,
      previousRsi: activeStock.history[index - 1]?.rsi ?? null,
      average: movingAverage(activeStock.history, index),
      average50: movingAverage(activeStock.history, index, 50),
      average200: movingAverage(activeStock.history, index, 200)
    })).filter((point) => Date.parse(point.date) >= cutoff.getTime());
  }

  byId("explorer-title").textContent = (item.name || activeStock.name) + " · " + activeStock.symbol;
  byId("explorer-subtitle").textContent = (item.sector || activeStock.sector) + streakSuffix
    + " · Viimane kuupäev " + formatPointLabel(latest.date, isIntraday) + " · " + dataSourceLabel(activeStock)
    + (explorerState.intraday && !isIntraday ? " · Päevasisesed andmed puuduvad; kuvatakse päevaandmed" : "");
  byId("detail-price").textContent = "$" + number.format(latest.close);
  byId("detail-rsi").textContent = latest.rsi !== null ? decimal.format(latest.rsi) : "—";
  const quote = quoteSummary(item.symbol);
  byId("latest-quote").textContent = Number.isFinite(quote.price)
    ? "Viimane noteering $" + number.format(quote.price) + " · "
      + (quote.time?.includes("T") ? dataTimeFormat : dateFormat).format(new Date(quote.time))
      + " · " + dataSourceLabel(quote.source)
    : "Noteering puudub";

  // Five trading days and daily averages must never use minute bars.
  const baseForAnalysis = dailyStock?.history?.length ? dailyStock : { history: [] };
  const analysis = analyzeStock(baseForAnalysis);
  byId("assessment-title").textContent = analysis.label;
  byId("signal-description").textContent = analysis.description;
  byId("price-trend").textContent = directionText(analysis.priceChange, "%");
  byId("rsi-trend").textContent = directionText(analysis.rsiChange, " punkti");

  const dailyPrice = dailyStock?.history?.at(-1)?.close;
  const posText = (avg) => {
    if (avg === null) return "Andmeid vähe";
    const position = dailyPrice > avg ? "Üle keskmise" : dailyPrice < avg ? "Alla keskmise" : "Keskmisega võrdne";
    return position + " · $" + number.format(avg);
  };

  byId("average-position").textContent = posText(analysis.average);
  byId("average-50").textContent = posText(analysis.average50);
  byId("average-200").textContent = posText(analysis.average200);

  const recent = points.filter((point) => point.rsi !== null);
  if (recent.length > 0) {
    const lowest = recent.reduce((best, point) => point.rsi < best.rsi ? point : best);
    const highest = Math.max(...recent.map((point) => point.rsi));
    byId("rsi-range").textContent = decimal.format(lowest.rsi) + "–" + decimal.format(highest) + " · madalaim " + formatPointLabel(lowest.date, isIntraday) + ".";
  } else {
    byId("rsi-range").textContent = "—";
  }

  if (effectiveNative) {
    renderChart("price-chart", points, "close", isIntraday && activeStock.history[0].date.includes("T"));
    renderChart("rsi-chart", points, "rsi", isIntraday && activeStock.history[0].date.includes("T"));
  }

  const history = byId("history-list");
  history.replaceChildren();
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    const row = element("tr");
    row.append(
      element("td", "", formatPointLabel(point.date, isIntraday && point.date.includes("T"))),
      element("td", "", number.format(point.close)),
      element("td", "", point.rsi === null ? "—" : decimal.format(point.rsi)),
      element("td", "", signalFor(point.rsi).label)
    );
    history.append(row);
  }
}

async function loadStockData(item, useCache) {
  const current = explorerState.marketData.get(item.symbol);
  const historyCheckedAt = Math.max(current?.fetchedAt || 0, explorerState.historyAttempts.get(item.symbol) || 0);
  const historyIsFresh = current?.history?.length && Number.isFinite(historyCheckedAt)
    && Date.now() - historyCheckedAt < HISTORY_REFRESH_MS;
  const customName = item.name && item.name !== item.symbol ? item.name : "";
  if (!useCache || !historyIsFresh) {
    explorerState.historyAttempts.set(item.symbol, Date.now());
    const data = await fetchYahooSymbol(item.symbol, customName, useCache, "1d", "2y");
    if (!data.refreshFailed) explorerState.historyAttempts.delete(item.symbol);
    const updated = { ...data, fetchedAt: data.fetchedAt || (data.refreshFailed ? undefined : Date.now()) };
    explorerState.marketData.set(item.symbol, updated);
    if (!data.refreshFailed) explorerState.latestQuotes.set(item.symbol, updated);
    return !data.refreshFailed;
  }
  // Only a few daily bars are needed for the current quote and its daily change.
  const quote = await fetchYahooSymbol(item.symbol, customName, useCache, "1d", "5d", 1);
  if (!quote.refreshFailed) explorerState.latestQuotes.set(item.symbol, quote);
  return !quote.refreshFailed;
}

async function refreshStockData(item, useCache) {
  const active = explorerState.stockRefreshes.get(item.symbol);
  if (active) {
    if (useCache || !active.useCache) return active.pending;
    await active.pending;
    return refreshStockData(item, false);
  }
  const pending = loadStockData(item, useCache);
  explorerState.stockRefreshes.set(item.symbol, { pending, useCache });
  try {
    return await pending;
  } finally {
    explorerState.stockRefreshes.delete(item.symbol);
  }
}

async function refreshSelectedStock(item, interval, useCache) {
  let succeeded = false;
  try {
    succeeded = await refreshStockData(item, useCache);
  } catch {
    // Preserve the last known history while its provider is unavailable.
  }
  if (interval) {
    const range = interval === "1m" ? "1d" : "5d";
    try {
      const customName = item.name && item.name !== item.symbol ? item.name : "";
      const intraday = await fetchYahooSymbol(item.symbol, customName, useCache, interval, range);
      explorerState.intradayData.set(item.symbol + ":" + interval, intraday);
    } catch {
      succeeded = false;
    }
  }
  renderOverview();
  renderCustomList();
  renderDetail();
  return succeeded;
}

async function refreshSelectedAndRender(useCache = false) {
  const item = findItemBySymbol(explorerState.selected) || activeListItems()[0];
  if (!item) return;
  const interval = explorerState.intraday;
  const refreshKey = item.symbol + ":" + interval;
  renderDetail();
  const active = explorerState.selectedRefreshes.get(refreshKey);
  if (active) {
    if (useCache || !active.useCache) return active.pending;
    await active.pending;
    return refreshSelectedAndRender(false);
  }
  const pending = refreshSelectedStock(item, interval, useCache);
  explorerState.selectedRefreshes.set(refreshKey, { pending, useCache });
  try {
    return await pending;
  } finally {
    explorerState.selectedRefreshes.delete(refreshKey);
  }
}

function renderRefreshProgress() {
  const progress = explorerState.progress;
  const notice = byId("refresh-progress");
  notice.hidden = !progress;
  if (!progress) return;
  notice.textContent = progress.label + " · Kontrollitud " + progress.completed + "/" + progress.total
    + " · Ebaõnnestus " + progress.failed.length
    + (progress.failed.length ? " (" + progress.failed.join(", ") + ")" : "")
    + (explorerState.loading ? " · Värskendan…" : " · Valmis");
}

function recordRefreshResult(symbol, succeeded) {
  explorerState.progress.completed++;
  if (!succeeded) explorerState.progress.failed.push(symbol);
  renderRefreshProgress();
}

async function refreshAllLiveStocks(useCache = false) {
  if (explorerState.loading) return;
  explorerState.loading = true;
  const refreshBtn = byId("refresh-live");
  refreshBtn.disabled = true;
  const list = [...activeListItems()];
  explorerState.progress = {
    label: explorerState.listMode === "kings" ? "Dividend Kings" : "Minu vaba valik",
    completed: 0, total: list.length, failed: []
  };
  renderRefreshProgress();

  renderOverview();
  renderCustomList();
  renderDetail();

  try {
    const selectedSymbol = explorerState.selected;
    const succeeded = await refreshSelectedAndRender(useCache);
    if (list.some((item) => item.symbol === selectedSymbol)) recordRefreshResult(selectedSymbol, succeeded);

    const ordered = list.filter((item) => item.symbol !== selectedSymbol);

    for (const item of ordered) {
      try {
        const succeeded = await refreshStockData(item, useCache);
        const data = explorerState.marketData.get(item.symbol);
        if (!item.name || item.name === item.symbol) {
          item.name = data.name;
        }
        recordRefreshResult(item.symbol, succeeded);
      } catch (error) {
        recordRefreshResult(item.symbol, false);
        if (!explorerState.marketData.get(item.symbol)?.history) {
          explorerState.marketData.set(item.symbol, {
            symbol: item.symbol,
            name: item.name,
            error: error.message || "Ootab andmeid"
          });
        }
      }
      renderOverview();
      renderCustomList();
      if (item.symbol === explorerState.selected) {
        renderDetail();
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    saveStocks();
  } finally {
    explorerState.loading = false;
    refreshBtn.disabled = false;
    renderRefreshProgress();
  }
}

async function handleAddStock(event) {
  event.preventDefault();
  const addBtn = byId("custom-add-btn");
  addBtn.disabled = true;
  try {
    const symbolInput = byId("custom-symbol");
    const nameInput = byId("custom-name");
    const { symbol, tvSymbol } = parseSymbolInput(symbolInput.value);
    const customName = nameInput.value.trim();

    showFeedback("Lisan sümboli " + symbol + "…");
    let resolvedName = customName || symbol;
    try {
      const data = await fetchYahooSymbol(symbol, customName, false, "1d", "2y");
      explorerState.marketData.set(symbol, data);
      resolvedName = customName || data.name || symbol;
    } catch {
      // Even if Yahoo proxy is unavailable, add the stock and show it on TradingView chart!
    }

    const existing = explorerState.customStocks.find((item) => item.symbol === symbol);
    if (existing) {
      existing.tvSymbol = tvSymbol;
      if (customName) existing.name = customName;
      explorerState.selected = existing.symbol;
      showFeedback(symbol + " valiti graafikule.");
    } else {
      explorerState.customStocks.unshift({
        symbol,
        tvSymbol,
        name: resolvedName,
        sector: "Vaba valik"
      });
      explorerState.selected = symbol;
      showFeedback(symbol + " lisati nimekirja.");
    }

    symbolInput.value = "";
    nameInput.value = "";
    saveStocks();
    renderOverview();
    renderCustomList();
    renderDetail();
  } catch (error) {
    showFeedback(error.message, true);
  } finally {
    addBtn.disabled = false;
  }
}

function resetWatchlist() {
  explorerState.customStocks = DEFAULT_CUSTOM_STOCKS.map((item) => ({ ...item }));
  explorerState.selected = explorerState.customStocks[0].symbol;
  saveStocks();
  showFeedback("Vaikimisi aktsiate nimekiri taastati.");
  refreshAllLiveStocks(false);
}

function updateThemeButton() {
  const isLight = document.documentElement.dataset.theme === "light";
  const button = byId("theme-toggle");
  button.textContent = isLight ? "Tume teema" : "Hele teema";
  button.setAttribute("aria-pressed", String(isLight));
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f7f9f5" : "#101817";
  updateThemeButton();
  const item = findItemBySymbol(explorerState.selected) || activeListItems()[0];
  if (item) renderTradingViewWidget(item, true);
  try {
    localStorage.setItem("stock-radar-theme", theme);
  } catch {
    // Theme toggle works even without localStorage.
  }
}

explorerState.customStocks = loadSavedStocks();

byId("theme-toggle").addEventListener("click", toggleTheme);
updateThemeButton();

byId("custom-stock-form").addEventListener("submit", handleAddStock);
byId("worker-url-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const url = new URL(byId("worker-url-input").value.trim());
    if (url.protocol !== "https:") throw new Error("Workeri aadress peab algama https://");
    explorerState.workerApiUrl = url.origin;
    try { localStorage.setItem(CUSTOM_WORKER_KEY, url.origin); } catch {}
    byId("worker-url-form").hidden = true;
    showFeedback("Cloudflare Worker ühendatud: " + url.origin);
    refreshAllLiveStocks(false);
  } catch (error) {
    showFeedback(error.message || "Vigane Workeri aadress.", true);
  }
});
byId("reset-watchlist").addEventListener("click", resetWatchlist);
byId("refresh-live").addEventListener("click", () => refreshAllLiveStocks(false));
byId("refresh-explorer-chart").addEventListener("click", () => {
  const item = findItemBySymbol(explorerState.selected) || activeListItems()[0];
  if (item) renderTradingViewWidget(item, true);
});

byId("list-mode-controls").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-list]");
  if (!button) return;
  explorerState.listMode = button.dataset.list;
  for (const item of byId("list-mode-controls").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  const currentList = activeListItems();
  if (!currentList.some((s) => s.symbol === explorerState.selected)) {
    explorerState.selected = currentList[0].symbol;
  }
  saveView();
  renderOverview();
  renderCustomList();
  renderDetail();
  if (explorerState.loading) {
    refreshSelectedAndRender(true);
  } else {
    refreshAllLiveStocks(true);
  }
});

byId("kings-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  explorerState.kingsFilter = button.dataset.filter;
  saveView();
  for (const item of byId("kings-filters").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  renderCustomList();
});

byId("kings-search").addEventListener("input", (event) => {
  explorerState.kingsSearch = event.target.value;
  saveView();
  renderCustomList();
});

byId("sort-stocks").addEventListener("change", (event) => {
  if (!SORT_ORDERS.includes(event.target.value)) return;
  explorerState.sortOrder = event.target.value;
  saveView();
  renderCustomList();
});

byId("ranges").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-days]");
  if (!button) return;
  explorerState.days = Number(button.dataset.days);
  explorerState.intraday = button.dataset.intraday || "";
  saveView();
  for (const item of byId("ranges").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  refreshSelectedAndRender(true);
});

byId("chart-mode-controls").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  explorerState.chartMode = button.dataset.mode;
  saveView();
  for (const item of byId("chart-mode-controls").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  renderDetail();
});

setInterval(() => {
  if (document.visibilityState === "visible") {
    if (Date.now() - snapshotCheckedAt >= 60000) {
      loadPublishedSnapshots().then(() => { renderOverview(); renderCustomList(); renderDetail(); }).catch(showInitializationError);
    }
    refreshSelectedAndRender(true);
  }
}, 15000);

initializeExplorer().catch(showInitializationError);
