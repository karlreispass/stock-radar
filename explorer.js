"use strict";

const CUSTOM_STORAGE_KEY = "stock-radar-custom-stocks";
const CUSTOM_SELECTED_KEY = "stock-radar-custom-selected";

const DEFAULT_CUSTOM_STOCKS = [
  { symbol: "AAPL", tvSymbol: "NASDAQ:AAPL", name: "Apple" },
  { symbol: "MSFT", tvSymbol: "NASDAQ:MSFT", name: "Microsoft" },
  { symbol: "NVDA", tvSymbol: "NASDAQ:NVDA", name: "NVIDIA" },
  { symbol: "GOOGL", tvSymbol: "NASDAQ:GOOGL", name: "Alphabet" },
  { symbol: "AMZN", tvSymbol: "NASDAQ:AMZN", name: "Amazon" },
  { symbol: "KO", tvSymbol: "NYSE:KO", name: "Coca-Cola" },
  { symbol: "PEP", tvSymbol: "NASDAQ:PEP", name: "PepsiCo" }
];

const explorerState = {
  stocks: [],
  marketData: new Map(),
  fallbackData: new Map(),
  selected: "AAPL",
  days: 90,
  chartMode: "native",
  tvChartKey: "",
  workerApiUrl: "",
  loading: false
};

const number = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("et-EE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const byId = (id) => document.getElementById(id);

function formatDate(value) {
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
            name: (item.name || "").trim() || symbol
          };
        });
      }
    }
  } catch {
    // Ignore storage read errors and use defaults.
  }
  return DEFAULT_CUSTOM_STOCKS.map((item) => ({ ...item }));
}

function saveStocks() {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(explorerState.stocks));
    localStorage.setItem(CUSTOM_SELECTED_KEY, explorerState.selected);
  } catch {
    // Working in-memory when browser storage is blocked.
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

function parseYahooChartResponse(json, requestedSymbol, customName) {
  const result = json?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp) || !result.indicators?.quote?.[0]) {
    throw new Error("Aktsia " + requestedSymbol + " hinnaandmeid ei leitud.");
  }
  const meta = result.meta || {};
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close || [];
  const adjCloses = result.indicators.adjclose?.[0]?.adjclose || closes;

  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const rawClose = closes[i];
    const adjClose = adjCloses[i] ?? rawClose;
    if (!Number.isFinite(rawClose) || rawClose <= 0 || !Number.isFinite(adjClose) || adjClose <= 0) continue;
    const isoDate = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    byDate.set(isoDate, {
      date: isoDate,
      close: Number(adjClose.toFixed(4)),
      quote_close: Number(rawClose.toFixed(4))
    });
  }

  // Ensure the real-time regularMarketPrice is reflected in the latest trading day.
  if (Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0 && Number.isFinite(meta.regularMarketTime)) {
    const liveDate = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
    const livePrice = Number(meta.regularMarketPrice.toFixed(4));
    byDate.set(liveDate, {
      date: liveDate,
      close: livePrice,
      quote_close: livePrice
    });
  }

  const rows = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 21) {
    throw new Error("Aktsial " + requestedSymbol + " on RSI jaoks liiga vähe kauplemispäevi.");
  }
  const rsiValues = calculateRsi(rows.map((r) => r.close), 14);
  const history = rows.map((row, idx) => ({
    ...row,
    rsi: rsiValues[idx] !== null ? Number(rsiValues[idx].toFixed(4)) : null
  }));

  const exchange = meta.exchangeName || meta.fullExchangeName || "USA börs";
  const resolvedName = customName || meta.shortName || meta.longName || requestedSymbol;
  const marketTime = Number.isFinite(meta.regularMarketTime)
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return {
    symbol: requestedSymbol,
    name: resolvedName,
    sector: exchange + " · reaalajas",
    liveTime: marketTime,
    isRealtime: true,
    history
  };
}

async function fetchYahooSymbol(symbol, customName) {
  const yahooSymbol = symbol.replace(".", "-");
  const targetUrl = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(yahooSymbol)
    + "?interval=1d&range=2y&includeAdjustedClose=true";

  const endpoints = [];
  if (explorerState.workerApiUrl) {
    endpoints.push(explorerState.workerApiUrl + "/v1/chart?symbol=" + encodeURIComponent(yahooSymbol));
  }
  endpoints.push(
    "https://corsproxy.io/?" + encodeURIComponent(targetUrl),
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(targetUrl),
    "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(targetUrl)
  );

  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(9000)
      });
      if (!response.ok) continue;
      const json = await response.json();
      if (json?.chart?.result?.[0]) {
        return parseYahooChartResponse(json, symbol, customName);
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (explorerState.fallbackData.has(symbol)) {
    const fallback = structuredClone(explorerState.fallbackData.get(symbol));
    if (customName) fallback.name = customName;
    fallback.isRealtime = false;
    return fallback;
  }
  throw lastError || new Error("Sümboli " + symbol + " reaalajas andmeid ei saanud laadida.");
}

async function initConfigAndFallback() {
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
  try {
    const snapResp = await fetch("data/stocks.json", { cache: "no-store" });
    if (snapResp.ok) {
      const snap = await snapResp.json();
      if (Array.isArray(snap.stocks)) {
        for (const stock of snap.stocks) {
          explorerState.fallbackData.set(stock.symbol, stock);
        }
      }
    }
  } catch {
    // Ignore fallback snapshot failure.
  }
}

function renderOverview() {
  const loadedStocks = explorerState.stocks
    .map((item) => explorerState.marketData.get(item.symbol))
    .filter((stock) => stock && Array.isArray(stock.history) && stock.history.length > 0);

  byId("custom-stock-count").textContent = explorerState.stocks.length;
  if (loadedStocks.length === 0) {
    byId("custom-low-count").textContent = "—";
    byId("custom-recovery-count").textContent = "—";
    byId("custom-data-date").textContent = "—";
    return;
  }

  byId("custom-low-count").textContent = loadedStocks.filter((stock) => stock.history.at(-1).rsi < 40).length;
  byId("custom-recovery-count").textContent = loadedStocks.filter((stock) => analyzeStock(stock).label === "Võimalik ostukandidaat").length;

  const dates = loadedStocks.map((stock) => stock.history.at(-1).date).sort();
  byId("custom-data-date").textContent = formatDate(dates.at(-1));
  const anyFallback = loadedStocks.some((stock) => !stock.isRealtime);
  const nowStr = new Date().toLocaleTimeString("et-EE");
  byId("custom-updated-at").textContent = (anyFallback ? "Viimane salvestatud seis · " : "Reaalajas uuendatud ") + nowStr;

  const notice = byId("live-notice");
  if (anyFallback) {
    notice.className = "notice";
    notice.textContent = "OSA ANDMEID ON KOHALIKUST VARUKOOPIAST · Otseühendus Yahoo Finance'iga polnud hetkel kõigi sümbolite jaoks kättesaadav.";
  } else {
    notice.className = "notice live";
    notice.textContent = "REAALAJAS ANDMED · Yahoo Finance otsepäring ilma 15-minutilise viiteta. Viimane küünal ja RSI (14) arvestavad jooksva kauplemispäeva viimast hinda.";
  }
}

function renderCustomList() {
  const tbody = byId("custom-stock-list");
  tbody.replaceChildren();

  for (const item of explorerState.stocks) {
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
      element("small", "", item.symbol + " · " + (stock?.sector || "Laadin…"))
    );
    button.append(icon, nameWrap);
    button.addEventListener("click", () => {
      explorerState.selected = item.symbol;
      saveStocks();
      showFeedback("");
      renderCustomList();
      renderDetail();
    });
    nameCell.append(button);

    if (stock && stock.history?.length >= 2) {
      const latest = stock.history.at(-1);
      const previous = stock.history.at(-2);
      const change = (latest.close / previous.close - 1) * 100;
      const signal = signalFor(latest.rsi);
      const analysis = analyzeStock(stock);

      const priceCell = element("td", "price-cell");
      priceCell.append(
        element("strong", "", "$" + number.format(latest.close)),
        element("small", change >= 0 ? "positive" : "negative", (change >= 0 ? "+" : "") + number.format(change) + "%")
      );

      const rsiCell = element("td", "rsi-number" + (signal.kind === "low" ? " positive" : ""), latest.rsi !== null ? decimal.format(latest.rsi) : "—");
      rsiCell.append(element("small", "rsi-status", signal.label));

      const signalCell = element("td");
      signalCell.append(element("span", "badge " + analysis.kind, analysis.label));
      signalCell.title = analysis.description;

      row.append(
        nameCell,
        priceCell,
        rsiCell,
        trendCell(analysis.priceChange, "%"),
        trendCell(analysis.rsiChange, " p"),
        signalCell
      );
    } else {
      const statusText = stock?.error ? "Viga: " + stock.error : "Laadin reaalajas hinda…";
      const statusCell = element("td", stock?.error ? "negative" : "", statusText);
      statusCell.colSpan = 5;
      row.append(nameCell, statusCell);
    }

    const actionCell = element("td");
    const removeButton = element("button", "secondary small-button", "Eemalda");
    removeButton.type = "button";
    removeButton.disabled = explorerState.stocks.length <= 1;
    removeButton.setAttribute("aria-label", "Eemalda " + item.symbol);
    removeButton.addEventListener("click", () => {
      if (explorerState.stocks.length <= 1) return;
      explorerState.stocks = explorerState.stocks.filter((s) => s.symbol !== item.symbol);
      if (explorerState.selected === item.symbol) {
        explorerState.selected = explorerState.stocks[0].symbol;
      }
      saveStocks();
      showFeedback(item.symbol + " eemaldati nimekirjast.");
      renderOverview();
      renderCustomList();
      renderDetail();
    });
    actionCell.append(removeButton);
    row.append(actionCell);

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

function renderChart(containerId, points, field) {
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
  const minimum = isRsi ? 0 : Math.min(...values) * 0.985;
  const maximum = isRsi ? 100 : Math.max(...values) * 1.015;
  const x = (index) => left + index / (points.length - 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  const svg = svgElement("svg", {
    viewBox: "0 0 " + width + " " + height,
    role: "img",
    "aria-label": isRsi
      ? "Reaalajas RSI graafik, piirid 30, 40 ja 70."
      : "Reaalajas hinna ja liikuvate keskmiste graafik."
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
      marker.append(svgElement("title", {}, formatDate(point.date) + " · RSI " + decimal.format(point.rsi) + " · " + signal.label));
      svg.append(marker);
    }
  });
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const index = Math.round((points.length - 1) * fraction);
    svg.append(svgElement("text", {
      x: x(index),
      y: height - 5,
      fill: "var(--muted)",
      "font-size": 10,
      "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
    }, points[index].date.slice(5).split("-").reverse().join(".")));
  }
  container.append(svg);
}

function renderTradingViewWidget(item, force = false) {
  const container = byId("explorer-chart");
  const marketSymbol = item.tvSymbol || item.symbol;
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const key = marketSymbol + ":" + theme;
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
    interval: "D",
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

function renderDetail() {
  const item = explorerState.stocks.find((s) => s.symbol === explorerState.selected) || explorerState.stocks[0];
  if (!item) return;
  const stock = explorerState.marketData.get(item.symbol);

  const isNative = explorerState.chartMode === "native";
  byId("native-chart-section").hidden = !isNative;
  byId("tv-chart-section").hidden = isNative;
  byId("ranges").hidden = !isNative;

  if (!isNative) {
    renderTradingViewWidget(item);
  }

  if (!stock || !stock.history || stock.history.length < 2) {
    byId("explorer-title").textContent = (item.name || item.symbol) + " · " + item.symbol;
    byId("explorer-subtitle").textContent = stock?.error ? "Andmete laadimine ebaõnnestus: " + stock.error : "Laadin reaalajas hinnaajalugu ja arvutan RSI-d…";
    return;
  }

  const latest = stock.history.at(-1);
  const cutoff = new Date(latest.date + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - explorerState.days);
  const points = stock.history.map((point, index) => ({
    ...point,
    previousRsi: stock.history[index - 1]?.rsi ?? null,
    average: movingAverage(stock.history, index),
    average50: movingAverage(stock.history, index, 50),
    average200: movingAverage(stock.history, index, 200)
  })).filter((point) => Date.parse(point.date) >= cutoff.getTime());

  byId("explorer-title").textContent = stock.name + " · " + stock.symbol;
  byId("explorer-subtitle").textContent = stock.sector + " · Viimane kuupäev " + formatDate(latest.date);
  byId("detail-price").textContent = "$" + number.format(latest.close);
  byId("detail-rsi").textContent = latest.rsi !== null ? decimal.format(latest.rsi) : "—";

  const analysis = analyzeStock(stock);
  byId("assessment-title").textContent = analysis.label;
  byId("signal-description").textContent = analysis.description;
  byId("price-trend").textContent = directionText(analysis.priceChange, "%");
  byId("rsi-trend").textContent = directionText(analysis.rsiChange, " punkti");

  const posText = (avg) => avg === null
    ? "Andmeid vähe"
    : (latest.close > avg ? "Üle keskmise" : latest.close < avg ? "Alla keskmise" : "Keskmisega võrdne") + " · $" + number.format(avg);

  byId("average-position").textContent = posText(analysis.average);
  byId("average-50").textContent = posText(analysis.average50);
  byId("average-200").textContent = posText(analysis.average200);

  const monthStart = Date.parse(latest.date) - 29 * 86400000;
  const recent = stock.history.filter((point) => Date.parse(point.date) >= monthStart && point.rsi !== null);
  if (recent.length > 0) {
    const lowest = recent.reduce((best, point) => point.rsi < best.rsi ? point : best);
    const highest = Math.max(...recent.map((point) => point.rsi));
    byId("rsi-range").textContent = decimal.format(lowest.rsi) + "–" + decimal.format(highest) + " · madalaim " + formatDate(lowest.date) + ".";
  } else {
    byId("rsi-range").textContent = "—";
  }

  if (isNative) {
    renderChart("price-chart", points, "close");
    renderChart("rsi-chart", points, "rsi");
  }

  const history = byId("history-list");
  history.replaceChildren();
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    const row = element("tr");
    row.append(
      element("td", "", formatDate(point.date)),
      element("td", "", number.format(point.close)),
      element("td", "", point.rsi === null ? "—" : decimal.format(point.rsi)),
      element("td", "", signalFor(point.rsi).label)
    );
    history.append(row);
  }
}

async function refreshAllLiveStocks() {
  if (explorerState.loading) return;
  explorerState.loading = true;
  const refreshBtn = byId("refresh-live");
  refreshBtn.disabled = true;

  renderCustomList();
  renderDetail();

  try {
    await Promise.all(explorerState.stocks.map(async (item) => {
      try {
        const customName = item.name !== item.symbol ? item.name : "";
        const data = await fetchYahooSymbol(item.symbol, customName);
        if (!item.name || item.name === item.symbol) {
          item.name = data.name;
        }
        explorerState.marketData.set(item.symbol, data);
      } catch (error) {
        explorerState.marketData.set(item.symbol, {
          symbol: item.symbol,
          name: item.name,
          error: error.message || "Laadimine ebaõnnestus"
        });
      }
      renderOverview();
      renderCustomList();
      if (item.symbol === explorerState.selected) {
        renderDetail();
      }
    }));
    saveStocks();
  } finally {
    explorerState.loading = false;
    refreshBtn.disabled = false;
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

    showFeedback("Kontrollin sümbolit " + symbol + " ja laadin reaalajas andmeid…");
    const data = await fetchYahooSymbol(symbol, customName);
    explorerState.marketData.set(symbol, data);

    const existing = explorerState.stocks.find((item) => item.symbol === symbol);
    if (existing) {
      existing.tvSymbol = tvSymbol;
      if (customName) existing.name = customName;
      explorerState.selected = existing.symbol;
      showFeedback(symbol + " uuendati ja valiti graafikule.");
    } else {
      explorerState.stocks.unshift({
        symbol,
        tvSymbol,
        name: customName || data.name || symbol
      });
      explorerState.selected = symbol;
      showFeedback(symbol + " (" + data.name + ") lisati reaalajas nimekirja.");
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
  explorerState.stocks = DEFAULT_CUSTOM_STOCKS.map((item) => ({ ...item }));
  explorerState.selected = explorerState.stocks[0].symbol;
  saveStocks();
  showFeedback("Vaikimisi aktsiate nimekiri taastati.");
  refreshAllLiveStocks();
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
  if (explorerState.chartMode === "tradingview") {
    const item = explorerState.stocks.find((s) => s.symbol === explorerState.selected) || explorerState.stocks[0];
    if (item) renderTradingViewWidget(item, true);
  }
  try {
    localStorage.setItem("stock-radar-theme", theme);
  } catch {
    // Theme toggle works even without localStorage.
  }
}

explorerState.stocks = loadSavedStocks();
try {
  const savedSelected = localStorage.getItem(CUSTOM_SELECTED_KEY);
  if (savedSelected && explorerState.stocks.some((item) => item.symbol === savedSelected)) {
    explorerState.selected = savedSelected;
  } else {
    explorerState.selected = explorerState.stocks[0].symbol;
  }
} catch {
  explorerState.selected = explorerState.stocks[0].symbol;
}

byId("theme-toggle").addEventListener("click", toggleTheme);
updateThemeButton();

byId("custom-stock-form").addEventListener("submit", handleAddStock);
byId("reset-watchlist").addEventListener("click", resetWatchlist);
byId("refresh-live").addEventListener("click", refreshAllLiveStocks);
byId("refresh-explorer-chart").addEventListener("click", () => {
  const item = explorerState.stocks.find((s) => s.symbol === explorerState.selected) || explorerState.stocks[0];
  if (item) renderTradingViewWidget(item, true);
});

byId("ranges").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-days]");
  if (!button) return;
  explorerState.days = Number(button.dataset.days);
  for (const item of byId("ranges").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  renderDetail();
});

byId("chart-mode-controls").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  explorerState.chartMode = button.dataset.mode;
  for (const item of byId("chart-mode-controls").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  renderDetail();
});

// Auto-refresh live data every 60 seconds when tab is visible.
setInterval(() => {
  if (document.visibilityState === "visible") {
    refreshAllLiveStocks();
  }
}, 60000);

initConfigAndFallback().then(refreshAllLiveStocks);
