"use strict";

const state = { data: null, symbol: "KO", days: 90 };
const number = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat("et-EE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("et-EE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const byId = (id) => document.getElementById(id);

function formatDate(value) {
  return dateFormat.format(new Date(value));
}

function signalFor(current, previous) {
  if (current === null) return { label: "Andmeid vähe", kind: "", description: "RSI arvutamiseks on vaja rohkem ajalugu." };
  if (current < 30) return { label: "RSI alla 30", kind: "low", description: "RSI on alla 30. Tugev müügisurve võib jätkuda; see ei kinnita hinnapõhja." };
  if (current > 70) return { label: "RSI üle 70", kind: "high", description: "RSI on üle 70. Tugev ostuhoog võib püsida; see ei ole automaatne müügisignaal." };
  if (current < 40) return { label: "Jälgimisalas", kind: "watch", description: "RSI on alla 40. Võimaliku taastumise hindamiseks vaata ka hinna ja RSI suunda." };
  return { label: "Neutraalne", kind: "", description: "RSI on vahemikus 40–70." };
}

function stockSignal(stock) {
  return signalFor(stock.history.at(-1).rsi, stock.history.at(-2)?.rsi ?? null);
}


function directionText(change, unit) {
  if (change === null) return "Andmeid vähe";
  const direction = change > 0 ? "Tõuseb" : change < 0 ? "Langeb" : "Muutumatu";
  return direction + " " + (change > 0 ? "+" : "") + number.format(change) + unit;
}

function trendCell(change, unit) {
  const cell = element("td", "trend-cell");
  cell.append(element("strong", change > 0 ? "positive" : change < 0 ? "negative" : "", directionText(change, unit)));
  cell.append(element("small", "", "5 kauplemispäeva"));
  return cell;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function renderOverview() {
  const stocks = state.data.stocks;
  byId("stock-count").textContent = stocks.length;
  byId("low-count").textContent = stocks.filter((stock) => stock.history.at(-1).rsi < 40).length;
  byId("recovery-count").textContent = stocks.filter((stock) => analyzeStock(stock).label === "Võimalik ostukandidaat").length;
  const dates = stocks.map((stock) => stock.history.at(-1).date).sort();
  byId("data-date").textContent = formatDate(dates[0]);
  byId("updated-at").textContent = "Laaditud " + new Date(state.data.generated_at).toLocaleString("et-EE");
  const demo = state.data.mode === "demo";
  const age = Date.now() - Date.parse(dates[0] + "T00:00:00Z");
  const stale = age > 4 * 24 * 60 * 60 * 1000;
  const notice = byId("notice");
  notice.className = "notice" + (demo || stale ? "" : " live");
  if (demo) {
    notice.textContent = "NÄIDISANDMED · Hinnad ja signaalid on väljamõeldud. Pärisandmete jaoks käivita andmete uuendamise skript või GitHub Actions.";
  } else if (stale) {
    notice.textContent = "ANDMED VÕIVAD OLLA AEGUNUD · Vanim viimane kauplemispäev on " + formatDate(dates[0]) + ". Kontrolli GitHub Actionsi viimast käivitust.";
  } else {
    notice.textContent = "PÄEVAANDMED · Yahoo Finance / yfinance. Ainult lõppenud USA kauplemispäevad; see ei ole reaalajas hinnavoog.";
  }
  if (new Set(dates).size > 1) notice.textContent += " Aktsiate viimased andmekuupäevad erinevad.";
}

function renderStocks() {
  const body = byId("stock-list");
  body.replaceChildren();
  for (const stock of state.data.stocks) {
    const latest = stock.history.at(-1);
    const previous = stock.history.at(-2);
    const change = (latest.close / previous.close - 1) * 100;
    const signal = stockSignal(stock);
    const analysis = analyzeStock(stock);
    const row = element("tr", "stock-row" + (stock.symbol === state.symbol ? " selected" : ""));
    const nameCell = element("td");
    const button = element("button", "ticker-button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(stock.symbol === state.symbol));
    button.setAttribute("aria-label", "Vaata aktsiat " + stock.name);
    const icon = element("span", "company-icon", stock.symbol);
    icon.setAttribute("aria-hidden", "true");
    const name = element("span");
    name.append(element("strong", "", stock.name), element("small", "", stock.symbol + " · " + stock.sector));
    button.append(icon, name);
    button.addEventListener("click", () => { state.symbol = stock.symbol; renderStocks(); renderDetail(); });
    nameCell.append(button);
    const priceCell = element("td", "price-cell");
    priceCell.append(element("strong", "", "$" + number.format(latest.close)), element("small", change >= 0 ? "positive" : "negative", (change >= 0 ? "+" : "") + number.format(change) + "%"));
    const rsiCell = element("td", "rsi-number" + (signal.kind === "low" ? " positive" : ""), decimal.format(latest.rsi));
    rsiCell.append(element("small", "rsi-status", signal.label));
    const signalCell = element("td");
    signalCell.append(element("span", "badge " + analysis.kind, analysis.label));
    signalCell.title = analysis.description;
    row.append(nameCell, priceCell, rsiCell, trendCell(analysis.priceChange, "%"), trendCell(analysis.rsiChange, " p"), signalCell);
    body.append(row);
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
  if (valid.length < 2) { container.textContent = "Graafiku jaoks pole piisavalt andmeid."; return; }
  const values = valid.map((point) => point[field]);
  if (!isRsi) {
    for (const key of ["average", "average50", "average200"]) values.push(...points.filter((point) => Number.isFinite(point[key])).map((point) => point[key]));
  }
  const minimum = isRsi ? 0 : Math.min(...values) * 0.985;
  const maximum = isRsi ? 100 : Math.max(...values) * 1.015;
  const x = (index) => left + index / (points.length - 1) * (width - left - right);
  const y = (value) => top + (maximum - value) / (maximum - minimum) * (height - top - bottom);
  const svg = svgElement("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": isRsi ? "RSI graafik, piirid 30, 40 ja 70. Päevaväärtused on all tabelis." : "Korrigeeritud sulgemishinna ja 20 päeva keskmise graafik. Päevaväärtused on all tabelis." });
  const levels = isRsi ? [30, 40, 70] : [minimum, (minimum + maximum) / 2, maximum];
  if (isRsi) svg.append(svgElement("rect", { x: left, y: y(40), width: width - left - right, height: y(0) - y(40), fill: "var(--green)", opacity: ".035" }));
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
    svg.append(svgElement("path", { d: averagePath, fill: "none", stroke: "var(--amber)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
    for (const [key, color] of [["average50", "var(--trend50)"], ["average200", "var(--trend200)"]]) {
      const trendPath = points.map((point, index) => ({ point, index })).filter(({ point }) => Number.isFinite(point[key]))
        .map(({ point, index }, pathIndex) => (pathIndex ? "L" : "M") + x(index).toFixed(2) + "," + y(point[key]).toFixed(2)).join(" ");
      if (trendPath) svg.append(svgElement("path", { d: trendPath, fill: "none", stroke: color, "stroke-width": 1.8 }));
    }

  }
  points.forEach((point, index) => {
    if (point[field] === null) return;
    const signal = signalFor(point.rsi, point.previousRsi);
    if (isRsi && ["low", "watch"].includes(signal.kind)) {
      const marker = svgElement("circle", { cx: x(index), cy: y(point.rsi), r: 3, fill: signal.kind === "low" ? "var(--green)" : "var(--amber)" });
      marker.append(svgElement("title", {}, formatDate(point.date) + " · RSI " + decimal.format(point.rsi) + " · " + signal.label));
      svg.append(marker);
    }
  });
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const index = Math.round((points.length - 1) * fraction);
    svg.append(svgElement("text", { x: x(index), y: height - 5, fill: "var(--muted)", "font-size": 10, "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle" }, points[index].date.slice(5).split("-").reverse().join(".")));
  }
  container.append(svg);
}

function renderDetail() {
  const stock = state.data.stocks.find((item) => item.symbol === state.symbol);
  const latest = stock.history.at(-1);
  const cutoff = new Date(latest.date + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() - state.days);
  const points = stock.history.map((point, index) => ({ ...point, previousRsi: stock.history[index - 1]?.rsi ?? null, average: movingAverage(stock.history, index), average50: movingAverage(stock.history, index, 50), average200: movingAverage(stock.history, index, 200) })).filter((point) => Date.parse(point.date) >= cutoff.getTime());
  byId("detail-title").textContent = stock.name + " · " + stock.symbol;
  byId("detail-subtitle").textContent = stock.sector + " · Viimane kauplemispäev " + formatDate(latest.date);
  byId("detail-price").textContent = "$" + number.format(latest.close);
  byId("detail-rsi").textContent = decimal.format(latest.rsi);
  const analysis = analyzeStock(stock);
  byId("assessment-title").textContent = analysis.label;
  byId("signal-description").textContent = analysis.description;
  byId("price-trend").textContent = directionText(analysis.priceChange, "%");
  byId("rsi-trend").textContent = directionText(analysis.rsiChange, " punkti");
  byId("average-position").textContent = analysis.average === null ? "Andmeid vähe"
    : (latest.close > analysis.average ? "Üle keskmise" : latest.close < analysis.average ? "Alla keskmise" : "Keskmisega võrdne") + " · $" + number.format(analysis.average);
  const monthStart = Date.parse(latest.date) - 29 * 86400000;
  const recent = stock.history.filter((point) => Date.parse(point.date) >= monthStart && point.rsi !== null);
  const lowest = recent.reduce((best, point) => point.rsi < best.rsi ? point : best);
  const highest = Math.max(...recent.map((point) => point.rsi));
  byId("rsi-range").textContent = decimal.format(lowest.rsi) + "–" + decimal.format(highest) + " · madalaim " + formatDate(lowest.date) + ". Käimasoleva kuu põhi pole ette teada.";
  if (byId("tradingview-chart")) {
    renderTradingView(stock.symbol);
    byId("snapshot-date").textContent = (state.data.mode === "demo" ? "NÄIDISANDMED · " : "") + "Hinnangu kauplemispäev: " + formatDate(latest.date);
  } else {
    renderChart("price-chart", points, "close");
    renderChart("rsi-chart", points, "rsi");
  }
  renderResearch(stock);
  const history = byId("history-list");
  history.replaceChildren();
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    const row = element("tr");
    row.append(element("td", "", formatDate(point.date)), element("td", "", number.format(point.close)), element("td", "", point.rsi === null ? "—" : decimal.format(point.rsi)), element("td", "", signalFor(point.rsi, point.previousRsi).label));
    history.append(row);
  }
}

function validateData(data) {
  if (!data || !["demo", "live"].includes(data.mode) || !Number.isFinite(Date.parse(data.generated_at)) || !Array.isArray(data.stocks) || data.stocks.length !== 5) throw new Error("Andmefaili vorming ei sobi.");
  const symbols = new Set();
  for (const stock of data.stocks) {
    if (typeof stock.symbol !== "string" || symbols.has(stock.symbol) || typeof stock.name !== "string" || typeof stock.sector !== "string" || !Array.isArray(stock.history) || stock.history.length < 16) throw new Error("Aktsia andmed on vigased.");
    symbols.add(stock.symbol);
    let previousDate = "";
    for (const point of stock.history) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !Number.isFinite(Date.parse(point.date)) || point.date <= previousDate || !Number.isFinite(point.close) || point.close <= 0 || !(point.rsi === null || (Number.isFinite(point.rsi) && point.rsi >= 0 && point.rsi <= 100))) throw new Error("Hinnaajalugu on vigane.");
      if (point.quote_close !== undefined && (!Number.isFinite(point.quote_close) || point.quote_close <= 0)) throw new Error("Sulgemishind on vigane.");
      previousDate = point.date;
    }
    if (stock.history.at(-1).rsi === null) throw new Error("Viimane RSI puudub.");
  }
}

async function loadData() {
  const button = byId("refresh");
  button.disabled = true;
  try {
    const response = await fetch("data/stocks.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Andmefaili ei saanud laadida (HTTP " + response.status + ").");
    const data = await response.json();
    validateData(data);
    state.data = data;
    if (!data.stocks.some((stock) => stock.symbol === state.symbol)) state.symbol = data.stocks[0].symbol;
    renderOverview();
    renderStocks();
    renderDetail();
  } catch (error) {
    byId("notice").className = "notice error";
    byId("notice").textContent = "Laadimine ebaõnnestus. " + error.message + (state.data ? " Ekraanil on eelmise laadimise andmed." : " Käivita rakendus kohaliku veebiserveriga; juhis on README failis.");
  } finally {
    button.disabled = false;
  }
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
  if (byId("tradingview-chart")) renderTradingView(state.symbol);
  try {
    localStorage.setItem("stock-radar-theme", theme);
  } catch {
    // Changing the theme must work even when browser storage is blocked.
  }
}

byId("theme-toggle").addEventListener("click", toggleTheme);
updateThemeButton();

byId("refresh").addEventListener("click", loadData);
byId("ranges")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-days]");
  if (!button) return;
  state.days = Number(button.dataset.days);
  for (const item of byId("ranges").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  if (state.data) renderDetail();
});
byId("research-form").addEventListener("submit", saveResearchSettings);
byId("settings-export").addEventListener("click", exportResearchSettings);
byId("profile-form").addEventListener("submit", unlockProfile);
byId("profile-select").addEventListener("change", resetProfile);
byId("profile-lock").addEventListener("click", resetProfile);
loadResearchSettings().then(loadProfileService);
loadData();
