"use strict";

function movingAverage(history, index, period = 20) {
  if (index < period - 1) return null;
  return history.slice(index - period + 1, index + 1).reduce((sum, point) => sum + point.close, 0) / period;
}

function analyzeStock(stock, index = stock.history.length - 1) {
  // Historical analysis must see only information available on that day.
  const history = stock.history.slice(0, index + 1);
  const latest = history.at(-1);
  const baseline = history.at(-6);
  const average = movingAverage(history, index);
  const previousAverage = movingAverage(history, index - 1);
  const average50 = movingAverage(history, index, 50);
  const average200 = movingAverage(history, index, 200);
  if (!baseline || latest.rsi === null || baseline.rsi === null || average === null || previousAverage === null) {
    return { label: "Andmeid vähe", kind: "", candidate: false, description: "Hinnanguks on vaja vähemalt 21 sulgemishinda ja RSI väärtusi viie kauplemispäeva vahega.", priceChange: null, rsiChange: null, average, average50, average200 };
  }
  const priceChange = (latest.close / baseline.close - 1) * 100;
  const rsiChange = latest.rsi - baseline.rsi;
  const recentlyLow = history.slice(-5).some((point) => point.rsi !== null && point.rsi < 40);
  const crossedAverage = latest.close > average && history.at(-2).close <= previousAverage;
  const candidate = recentlyLow && rsiChange > 0 && crossedAverage;
  let label = "Selge signaal puudub", kind = "";
  if (candidate) { label = "Võimalik ostukandidaat"; kind = "low"; }
  else if (recentlyLow && rsiChange > 0 && priceChange > 0) { label = "Taastumise märgid"; kind = "recovery"; }
  else if (priceChange < 0 && rsiChange < 0) { label = "Langussurve jätkub"; kind = "high"; }
  else if (latest.rsi < 40) { label = "Jälgimisalas"; kind = "watch"; }
  const description = "RSI viimase viie kauplemispäeva jooksul alla 40: " + (recentlyLow ? "jah" : "ei")
    + ". RSI kõrgem kui viis kauplemispäeva tagasi: " + (rsiChange > 0 ? "jah" : "ei")
    + ". Hind ületas viimasel kauplemispäeval 20 päeva keskmise: " + (crossedAverage ? "jah" : "ei")
    + ". Ostukandidaadi jaoks peavad kõik kolm tingimust täituma. Ajalooline võrdlus on allpool; see ei kinnita tulevast tootlust.";
  return { label, kind, candidate, description, priceChange, rsiChange, average, average50, average200 };
}

function backtestStock(stock, feeBps = 10, monthlyContribution = 1000) {
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 500 || !Number.isFinite(monthlyContribution) || monthlyContribution <= 0) {
    throw new Error("Kontrolli võrdluse kulu ja kuumakse väärtusi.");
  }
  const history = stock.history;
  const fee = feeBps / 10000;
  const signalIndexes = [];
  // Use 200 observations as a common warm-up for all comparisons.
  for (let index = 199; index < history.length - 1; index++) {
    if (analyzeStock(stock, index).candidate && !analyzeStock(stock, index - 1).candidate) signalIndexes.push(index);
  }
  const outcomes = [5, 20, 60].map((days) => {
    const samples = [];
    for (const index of signalIndexes) {
      const entry = index + 1;
      const exit = entry + days;
      if (exit >= history.length) continue;
      const entryPrice = history[entry].close;
      const netReturn = (history[exit].close * (1 - fee) / (entryPrice * (1 + fee)) - 1) * 100;
      const worstDrop = Math.min(0, ...history.slice(entry, exit + 1).map((point) => (point.close / entryPrice - 1) * 100));
      samples.push({ signalDate: history[index].date, entryDate: history[entry].date, exitDate: history[exit].date, netReturn, worstDrop });
    }
    return { days, count: samples.length,
      averageReturn: samples.length ? samples.reduce((sum, row) => sum + row.netReturn, 0) / samples.length : null,
      winRate: samples.length ? samples.filter((row) => row.netReturn > 0).length / samples.length * 100 : null,
      worstDrop: samples.length ? Math.min(...samples.map((row) => row.worstDrop)) : null, samples };
  });
  let contributions = 0, cash = 0, signalShares = 0, regularShares = 0, purchases = 0, previousMonth = "";
  const executions = new Set(signalIndexes.map((index) => index + 1));
  for (let index = 200; index < history.length; index++) {
    const point = history[index];
    const month = point.date.slice(0, 7);
    if (month !== previousMonth) {
      contributions += monthlyContribution;
      cash += monthlyContribution;
      regularShares += monthlyContribution / (point.close * (1 + fee));
      previousMonth = month;
    }
    if (executions.has(index) && cash > 0) {
      signalShares += cash / (point.close * (1 + fee));
      cash = 0;
      purchases++;
    }
  }
  const finalPrice = history.at(-1)?.close ?? 0;
  return { outcomes, signals: signalIndexes.length, start: history[200]?.date ?? null, end: history.at(-1)?.date ?? null,
    contributions, cash, purchases, signalValue: cash + signalShares * finalPrice * (1 - fee),
    regularValue: regularShares * finalPrice * (1 - fee) };
}

if (typeof module !== "undefined") module.exports = { movingAverage, analyzeStock, backtestStock };
