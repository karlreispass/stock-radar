"use strict";

const CUSTOM_STORAGE_KEY = "stock-radar-custom-stocks";
const CUSTOM_SELECTED_KEY = "stock-radar-custom-selected";

const DEFAULT_CUSTOM_STOCKS = [
  { symbol: "NASDAQ:AAPL", name: "Apple" },
  { symbol: "NASDAQ:MSFT", name: "Microsoft" },
  { symbol: "NASDAQ:NVDA", name: "NVIDIA" },
  { symbol: "NASDAQ:GOOGL", name: "Alphabet" },
  { symbol: "NASDAQ:AMZN", name: "Amazon" },
  { symbol: "NYSE:KO", name: "Coca-Cola" },
  { symbol: "NASDAQ:PEP", name: "PepsiCo" }
];

const explorerState = {
  stocks: [],
  selected: "NASDAQ:AAPL",
  interval: "D",
  chartKey: ""
};

const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortSymbol(marketSymbol) {
  const parts = String(marketSymbol).split(":");
  return parts[parts.length - 1];
}

function normalizeSymbol(input) {
  const cleaned = String(input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^(?:[A-Z0-9]{1,12}:)?[A-Z0-9._-]{1,12}$/.test(cleaned)) {
    throw new Error("Sümbol võib sisaldada tähti, numbreid, punkti, sidekriipsu ja valikulist börsi eesliidet (nt AAPL või NASDAQ:AAPL).");
  }
  return cleaned;
}

function loadSavedStocks() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => item && typeof item.symbol === "string" && typeof item.name === "string")) {
        return parsed.map((item) => ({ symbol: normalizeSymbol(item.symbol), name: item.name.trim() || shortSymbol(item.symbol) }));
      }
    }
  } catch {
    // Fall back to default stocks if localStorage is unavailable or invalid.
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

function renderCustomList() {
  const tbody = byId("custom-stock-list");
  tbody.replaceChildren();
  const count = explorerState.stocks.length;
  byId("custom-count").textContent = count + (count === 1 ? " aktsia" : " aktsiat");

  for (const stock of explorerState.stocks) {
    const isSelected = stock.symbol === explorerState.selected;
    const row = element("tr", "stock-row" + (isSelected ? " selected" : ""));

    const nameCell = element("td");
    const button = element("button", "ticker-button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(isSelected));
    button.setAttribute("aria-label", "Vaata aktsiat " + stock.name + " (" + stock.symbol + ")");
    const ticker = shortSymbol(stock.symbol);
    const icon = element("span", "company-icon", ticker.slice(0, 5));
    icon.setAttribute("aria-hidden", "true");
    const labelWrap = element("span");
    labelWrap.append(
      element("strong", "", stock.name || ticker),
      element("small", "", stock.symbol)
    );
    button.append(icon, labelWrap);
    button.addEventListener("click", () => {
      explorerState.selected = stock.symbol;
      saveStocks();
      showFeedback("");
      renderCustomList();
      renderExplorerChart();
    });
    nameCell.append(button);

    const symbolCell = element("td");
    symbolCell.append(element("span", "badge", stock.symbol));

    const actionCell = element("td");
    const removeButton = element("button", "secondary small-button", "Eemalda");
    removeButton.type = "button";
    removeButton.disabled = explorerState.stocks.length <= 1;
    removeButton.setAttribute("aria-label", "Eemalda " + stock.name);
    removeButton.addEventListener("click", () => {
      if (explorerState.stocks.length <= 1) return;
      explorerState.stocks = explorerState.stocks.filter((item) => item.symbol !== stock.symbol);
      if (explorerState.selected === stock.symbol) {
        explorerState.selected = explorerState.stocks[0].symbol;
      }
      saveStocks();
      showFeedback(stock.symbol + " eemaldati nimekirjast.");
      renderCustomList();
      renderExplorerChart();
    });
    actionCell.append(removeButton);

    row.append(nameCell, symbolCell, actionCell);
    tbody.append(row);
  }
}

function renderExplorerChart(force = false) {
  const container = byId("explorer-chart");
  const status = byId("explorer-status");
  const current = explorerState.stocks.find((item) => item.symbol === explorerState.selected) || {
    symbol: explorerState.selected,
    name: shortSymbol(explorerState.selected)
  };
  const ticker = shortSymbol(current.symbol);
  byId("explorer-title").textContent = (current.name && current.name !== ticker ? current.name + " · " : "") + current.symbol;

  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const key = current.symbol + ":" + explorerState.interval + ":" + theme;
  if (!force && explorerState.chartKey === key) return;
  explorerState.chartKey = key;

  const wrapper = document.createElement("div");
  wrapper.className = "tradingview-widget-container";
  const chart = document.createElement("div");
  chart.className = "tradingview-widget-container__widget";
  const credit = document.createElement("div");
  credit.className = "tradingview-widget-copyright";
  const link = document.createElement("a");
  link.href = "https://www.tradingview.com/symbols/" + current.symbol.replace(":", "-") + "/";
  link.target = "_blank";
  link.rel = "noopener nofollow";
  link.textContent = ticker + " graafik TradingView’s";
  credit.append(link);
  wrapper.append(chart, credit);
  container.replaceChildren(wrapper);
  status.textContent = "TradingView’ graafik uueneb automaatselt. Saad sümbolit vahetada nii ülaltoodud tabelist kui ka otse graafiku otsingust.";

  const script = document.createElement("script");
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.type = "text/javascript";
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: current.symbol,
    interval: explorerState.interval,
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
  script.addEventListener("error", () => {
    if (!container.contains(wrapper)) return;
    explorerState.chartKey = "";
    status.textContent = "TradingView’ graafikut ei saanud laadida. Kontrolli internetiühendust või ava TradingView’ link.";
  });
  wrapper.append(script);
}

function handleAddStock(event) {
  event.preventDefault();
  try {
    const symbolInput = byId("custom-symbol");
    const nameInput = byId("custom-name");
    const symbol = normalizeSymbol(symbolInput.value);
    const short = shortSymbol(symbol);
    const customName = nameInput.value.trim();

    const existing = explorerState.stocks.find(
      (item) => item.symbol === symbol || shortSymbol(item.symbol) === short
    );
    if (existing) {
      existing.symbol = symbol;
      if (customName) existing.name = customName;
      explorerState.selected = existing.symbol;
      showFeedback(symbol + " on juba nimekirjas ja valiti graafikule.");
    } else {
      explorerState.stocks.unshift({
        symbol,
        name: customName || short
      });
      explorerState.selected = symbol;
      showFeedback(symbol + " lisati nimekirja.");
    }
    symbolInput.value = "";
    nameInput.value = "";
    saveStocks();
    renderCustomList();
    renderExplorerChart(true);
  } catch (error) {
    showFeedback(error.message, true);
  }
}

function resetWatchlist() {
  explorerState.stocks = DEFAULT_CUSTOM_STOCKS.map((item) => ({ ...item }));
  explorerState.selected = explorerState.stocks[0].symbol;
  saveStocks();
  showFeedback("Vaikimisi aktsiate nimekiri taastati.");
  renderCustomList();
  renderExplorerChart(true);
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
  renderExplorerChart(true);
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
byId("refresh-explorer-chart").addEventListener("click", () => renderExplorerChart(true));

byId("interval-controls").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-interval]");
  if (!button) return;
  explorerState.interval = button.dataset.interval;
  for (const item of byId("interval-controls").querySelectorAll("button")) {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  }
  renderExplorerChart(true);
});

renderCustomList();
renderExplorerChart();
