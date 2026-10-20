"use strict";

let researchSettings = null;
let researchPublishedSettings = null;
let researchSettingsError = "";

function validateResearchSettings(settings) {
  const symbols = ["KO", "PEP", "JNJ", "PG", "CL"];
  if (!settings || Object.keys(settings).sort().join() !== ["backtest", "events", "health_alerts", "targets"].join()) throw new Error("Seadistuse väljad ei sobi.");
  if (!settings || !settings.targets || !settings.events || !settings.backtest || typeof settings.health_alerts !== "boolean") throw new Error("Seadistus ei sobi.");
  if (Object.keys(settings.targets).sort().join() !== symbols.sort().join()) throw new Error("Sihthindade nimekiri ei sobi.");
  for (const value of Object.values(settings.targets)) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error("Sihthind peab olema positiivne.");
  }
  const kinds = ["watch", "candidate", "target", "oversold", "recovery"];
  if (Object.keys(settings.events).sort().join() !== kinds.sort().join() || kinds.some((kind) => typeof settings.events[kind] !== "boolean")) throw new Error("Teavituste valikud ei sobi.");
  if (Object.keys(settings.backtest).sort().join() !== ["fee_bps", "monthly_contribution"].join()) throw new Error("Võrdluse seadistus ei sobi.");
  const { fee_bps, monthly_contribution } = settings.backtest;
  if (!Number.isFinite(fee_bps) || fee_bps < 0 || fee_bps > 500 || !Number.isFinite(monthly_contribution) || monthly_contribution <= 0 || monthly_contribution > 1000000) throw new Error("Võrdluse kulu või kuumakse ei sobi.");
  return settings;
}

function setSettingsFields(settings) {
  for (const [symbol, target] of Object.entries(settings.targets)) byId("target-" + symbol).value = target ?? "";
  for (const [kind, enabled] of Object.entries(settings.events)) byId("event-" + kind).checked = enabled;
  byId("event-health").checked = settings.health_alerts;
  byId("backtest-fee").value = settings.backtest.fee_bps;
  byId("backtest-monthly").value = settings.backtest.monthly_contribution;
}

async function loadResearchSettings() {
  try {
    const response = await fetch("settings.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Avaldatud seadistust ei saanud laadida.");
    researchPublishedSettings = validateResearchSettings(await response.json());
    researchSettings = structuredClone(researchPublishedSettings);
    try {
      const saved = localStorage.getItem("stock-radar-settings");
      if (saved) researchSettings = validateResearchSettings(JSON.parse(saved));
    } catch {
      // Published settings remain usable when local preferences are unavailable.
    }
    setSettingsFields(researchSettings);
    showSettingsStatus();
    byId("settings-save").disabled = false;
    byId("settings-export").disabled = false;
    if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
  } catch (error) {
    researchSettingsError = error.message;
    byId("backtest-period").textContent = "Võrdluse seadistust ei saanud laadida.";
    byId("settings-status").textContent = error.message + " Sihthinnad ja ajalooline võrdlus ei ole saadaval.";
  }
}

function showSettingsStatus(message = "") {
  const differs = JSON.stringify(researchSettings) !== JSON.stringify(researchPublishedSettings);
  byId("settings-status").textContent = message + (differs
    ? " Lehe valikud erinevad avaldatud seadistusest. GitHubi automaatika kasutab endiselt repos olevat settings.json faili."
    : " Lehe valikud vastavad avaldatud settings.json failile. Teavituste saamiseks luba GitHubis Watch → Custom → Issues ning meilisätted.");
}

function readSettingsForm() {
  const settings = structuredClone(researchSettings);
  for (const symbol of Object.keys(settings.targets)) {
    const value = byId("target-" + symbol).value.trim();
    settings.targets[symbol] = value === "" ? null : Number(value);
  }
  for (const kind of Object.keys(settings.events)) settings.events[kind] = byId("event-" + kind).checked;
  settings.health_alerts = byId("event-health").checked;
  settings.backtest.fee_bps = Number(byId("backtest-fee").value);
  settings.backtest.monthly_contribution = Number(byId("backtest-monthly").value);
  return validateResearchSettings(settings);
}

function saveResearchSettings(event) {
  event.preventDefault();
  try {
    researchSettings = readSettingsForm();
    let message = "Valikud rakendatud selles vaates.";
    try { localStorage.setItem("stock-radar-settings", JSON.stringify(researchSettings)); }
    catch { message += " Brauser ei lubanud neid püsivalt salvestada."; }
    showSettingsStatus(message);
    if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
  } catch (error) { byId("settings-status").textContent = error.message; }
}

function exportResearchSettings() {
  try {
    const settings = readSettingsForm();
    const blob = new Blob([JSON.stringify(settings, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    byId("settings-status").textContent = "Fail laaditud alla. Asenda repos settings.json, tee commit ja push. Automaatika kasutab uut faili järgmisel käivitusel.";
  } catch (error) { byId("settings-status").textContent = error.message; }
}

function formatPercent(value) { return value === null ? "—" : number.format(value) + "%"; }

function renderResearch(stock) {
  const latest = stock.history.at(-1);
  const analysis = analyzeStock(stock);
  const position = (average) => average === null ? "Andmeid vähe" : (latest.close > average ? "Üle" : latest.close < average ? "Alla" : "Võrdne") + " · $" + number.format(average);
  byId("average-50").textContent = position(analysis.average50);
  byId("average-200").textContent = position(analysis.average200);
  const longTrend = analysis.average50 === null || analysis.average200 === null ? "Pika trendi jaoks on andmeid vähe."
    : "50 päeva keskmine on " + (analysis.average50 > analysis.average200 ? "200 päeva keskmisest kõrgem." : analysis.average50 < analysis.average200 ? "200 päeva keskmisest madalam." : "200 päeva keskmisega võrdne.");
  byId("long-trend").textContent = longTrend + " Need keskmised annavad tausta ega muuda kolme tingimusega ostukandidaadi reeglit.";
  if (!researchSettings) {
    byId("target-status").textContent = researchSettingsError || "Laadin sihthindade seadistust…";
    return;
  }
  const target = researchSettings.targets[stock.symbol];
  const quote = latest.quote_close;
  byId("target-status").textContent = target === null ? stock.symbol + ": sihthind määramata. Sisesta see allolevas seadistuses."
    : !Number.isFinite(quote) ? "Sihthind $" + number.format(target) + ". Korrigeerimata sulgemishind puudub; värskenda päevaandmeid Actionsi kaudu."
    : stock.symbol + " sihthind $" + number.format(target) + " · sulgemishind $" + number.format(quote) + " · "
      + (quote <= target ? "sihthind saavutatud" : "sihthinnani " + number.format((1 - target / quote) * 100) + "% langust praegusest sulgemishinnast");
  const report = backtestStock(stock, researchSettings.backtest.fee_bps, researchSettings.backtest.monthly_contribution);
  byId("backtest-period").textContent = report.start ? stock.symbol + " · " + formatDate(report.start) + " – " + formatDate(report.end)
    + " · " + (state.data.mode === "demo" ? "NÄIDISANDMED, mitte turu tulemus" : "Yahoo korrigeeritud sulgemishinnad") : "Võrdluseks on vaja üle 200 kauplemispäeva.";
  const body = byId("backtest-results");
  body.replaceChildren();
  for (const result of report.outcomes) {
    const row = element("tr");
    for (const value of [result.days + " kauplemispäeva", result.count, formatPercent(result.averageReturn), formatPercent(result.winRate), formatPercent(result.worstDrop)]) row.append(element("td", "", value));
    body.append(row);
  }
  byId("backtest-comparison").textContent = "Sissemaksed $" + number.format(report.contributions)
    + " · signaali ootamise lõppväärtus $" + number.format(report.signalValue)
    + " (sellest raha $" + number.format(report.cash) + ", oste " + report.purchases + ")"
    + " · igakuise ostmise lõppväärtus $" + number.format(report.regularValue) + ".";
  byId("backtest-cost").textContent = "Mõlemale strateegiale lisandub iga kuu esimese olemasoleva kauplemispäeva alguses $" + number.format(researchSettings.backtest.monthly_contribution)
    + ". Kulu ostul ja müügil: " + number.format(researchSettings.backtest.fee_bps / 100) + "% tehingu väärtusest; see on muudetav tasude ja hinnavahe hinnang.";
  const details = byId("backtest-trades");
  details.replaceChildren();
  for (const result of report.outcomes) {
    for (const sample of result.samples) {
      const row = element("tr");
      for (const value of [formatDate(sample.signalDate), formatDate(sample.entryDate), result.days, formatDate(sample.exitDate), formatPercent(sample.netReturn), formatPercent(sample.worstDrop)]) row.append(element("td", "", value));
      details.append(row);
    }
  }
}
