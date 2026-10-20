"use strict";

const tradingViewSymbols = {
  KO: "NYSE:KO",
  PEP: "NASDAQ:PEP",
  JNJ: "NYSE:JNJ",
  PG: "NYSE:PG",
  CL: "NYSE:CL"
};
let tradingViewKey = "";
let tradingViewSymbol = "KO";

function renderTradingView(symbol, force = false) {
  const container = document.getElementById("tradingview-chart");
  const status = document.getElementById("tradingview-status");
  const marketSymbol = tradingViewSymbols[symbol];
  if (!marketSymbol) {
    container.replaceChildren();
    tradingViewKey = "";
    status.textContent = "Selle aktsia TradingView’ sümbol pole seadistatud.";
    return;
  }
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const key = marketSymbol + ":" + theme;
  // Keep the current chart interval and zoom when only the daily data refreshes.
  if (!force && tradingViewKey === key) return;
  tradingViewKey = key;
  tradingViewSymbol = symbol;

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
  link.textContent = symbol + " stock chart";
  credit.append(link, " by TradingView");
  wrapper.append(chart, credit);
  container.replaceChildren(wrapper);
  status.textContent = "TradingView’ graafik uueneb automaatselt; võimalikku viivitust näitab graafiku turuandmete märge. Kui graafik ei ilmu, ava TradingView’ link.";

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
    // Symbol changes go through our table so the daily assessment stays in sync.
    allow_symbol_change: false,
    save_image: false,
    studies: ["RSI@tv-basicstudies"],
    calendar: false,
    support_host: "https://www.tradingview.com"
  });
  script.addEventListener("error", () => {
    if (!container.contains(wrapper)) return;
    tradingViewKey = "";
    status.textContent = "TradingView’ graafikut ei saanud laadida. Proovi uuesti või ava TradingView’ link. Päevahinnangut saab endiselt kasutada.";
  });
  wrapper.append(script);
}

document.getElementById("refresh-chart").addEventListener("click", () => {
  renderTradingView(tradingViewSymbol, true);
});
// The external chart can load even when our daily snapshot is unavailable.
renderTradingView("KO");
