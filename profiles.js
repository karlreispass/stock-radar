"use strict";

let profileApiUrl = "";
let profileAccessCode = "";
let profileRequestVersion = 0;

function profileName() { return "Kasutaja " + byId("profile-select").value.at(-1); }

function setProfileEditing(enabled) {
  byId("settings-save").disabled = !enabled;
  const ids = ["backtest-fee", "backtest-monthly", "event-health"];
  for (const symbol of ["KO", "PEP", "JNJ", "PG", "CL"]) ids.push("target-" + symbol);
  for (const kind of ["watch", "candidate", "target", "oversold", "recovery"]) ids.push("event-" + kind);
  for (const id of ids) byId(id).disabled = !enabled;
}

function resetProfile() {
  profileRequestVersion++;
  profileAccessCode = "";
  byId("profile-code").value = "";
  setProfileEditing(false);
  // Do not display the previous user's targets under the newly selected name.
  researchSettings = structuredClone(researchPublishedSettings);
  for (const symbol of Object.keys(researchSettings.targets)) researchSettings.targets[symbol] = null;
  setSettingsFields(researchSettings);
  byId("profile-status").textContent = profileName() + " valitud. Sisesta profiili kood.";
  byId("settings-status").textContent = "Profiil on lukus. Muutmiseks ava see oma koodiga.";
  if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
  try { localStorage.setItem("stock-radar-profile", byId("profile-select").value); } catch {}
}

async function profileRequest(id, code, settings) {
  const response = await fetch(profileApiUrl + "/v1/profiles/" + id, {
    method: settings ? "PUT" : "GET",
    headers: { Authorization: "Bearer " + code, ...(settings ? { "Content-Type": "application/json" } : {}) },
    ...(settings ? { body: JSON.stringify(settings) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(15000)
  });
  const record = await response.json();
  if (!response.ok) throw new Error(record.error || "Profiiliteenus ei vasta.");
  if (record.id !== id || typeof record.enabled !== "boolean") throw new Error("Profiiliteenuse vastus ei sobi.");
  validateResearchSettings(record.settings);
  return record;
}

async function unlockProfile(event) {
  event.preventDefault();
  if (!profileApiUrl) return;
  const code = byId("profile-code").value.trim();
  if (code.length < 4) { byId("profile-status").textContent = "Sisesta vähemalt 4 märgiga profiili kood."; return; }
  const id = byId("profile-select").value;
  const version = ++profileRequestVersion;
  profileAccessCode = "";
  setProfileEditing(false);
  byId("profile-status").textContent = "Laadin profiili…";
  try {
    const record = await profileRequest(id, code);
    if (version !== profileRequestVersion) return;
    profileAccessCode = code;
    byId("profile-code").value = "";
    researchSettings = structuredClone(record.settings);
    setSettingsFields(researchSettings);
    setProfileEditing(true);
    byId("profile-status").textContent = profileName() + " avatud. " + (record.enabled
      ? "Valikud on salvestatud teenusesse."
      : "Esimene salvestamine aktiveerib selle profiili teavitused.");
    byId("settings-status").textContent = "Muuda valikuid ja vajuta „Salvesta profiil”. Kõigi kolme profiili teavitused jõuavad ühisesse repo Issue-voogu.";
    if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
  } catch (error) {
    if (version === profileRequestVersion) byId("profile-status").textContent = error.message || "Profiili avamine ebaõnnestus.";
  }
}

async function saveServerProfile(event) {
  event.preventDefault();
  if (!profileAccessCode) { byId("settings-status").textContent = "Ava kõigepealt profiil oma koodiga."; return; }
  const version = profileRequestVersion;
  const id = byId("profile-select").value;
  byId("settings-save").disabled = true;
  try {
    const settings = readSettingsForm();
    const record = await profileRequest(id, profileAccessCode, settings);
    if (version !== profileRequestVersion) return;
    researchSettings = structuredClone(record.settings);
    setSettingsFields(researchSettings);
    byId("settings-status").textContent = profileName() + " salvestatud. Järgmine päevane Actionsi kontroll kasutab neid valikuid; faili ega commit’i pole vaja.";
    byId("profile-status").textContent = profileName() + " · salvestatud " + new Date(record.updated_at).toLocaleString("et-EE");
    if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
  } catch (error) {
    if (version === profileRequestVersion) byId("settings-status").textContent = "Salvestamine ei õnnestunud: " + error.message + " Teenusesse salvestamist ei ole kinnitatud.";
  } finally {
    if (version === profileRequestVersion) byId("settings-save").disabled = false;
  }
}

async function loadProfileService() {
  try {
    const response = await fetch("profile-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Profiiliteenuse seadistust ei saanud laadida.");
    const config = await response.json();
    if (!config.api_url) {
      byId("profile-status").textContent = "Profiiliteenus pole veel ühendatud. Praegu töötavad ainult brauseri valikud ja repo senised teavitused.";
      return;
    }
    const url = new URL(config.api_url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Profiiliteenuse aadress ei sobi.");
    if (!researchPublishedSettings) throw new Error("Oota päevaandmete seadistuse edukat laadimist.");
    profileApiUrl = url.origin;
    byId("profile-select").value = "user-1";
    byId("profile-select").disabled = false;
    byId("profile-code").disabled = false;
    byId("profile-unlock").disabled = false;
    byId("profile-lock").disabled = false;
    byId("settings-save").textContent = "Salvesta profiil";
    byId("settings-export").hidden = true;
    byId("legacy-settings-note").hidden = true;
    try {
      const saved = localStorage.getItem("stock-radar-profile");
      if (["user-1", "user-2", "user-3"].includes(saved)) byId("profile-select").value = saved;
    } catch {}
    resetProfile();
  } catch (error) {
    byId("profile-status").textContent = error.message + " Profiilide salvestamine pole saadaval.";
  }
}
