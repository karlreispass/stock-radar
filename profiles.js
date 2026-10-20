"use strict";

const PROFILE_SESSION_KEY = "stock-radar-session";
let profileApiUrl = "";
let profileAccessCode = "";
let profileRequestVersion = 0;
let profileSaving = false;
let profileSavedSettings = null;

function profileName() { return "Kasutaja " + byId("profile-select").value.at(-1); }

function setProfileEditing(enabled) {
  const ids = ["settings-save", "quick-target", "quick-target-save", "backtest-fee", "backtest-monthly", "event-health"];
  for (const symbol of ["KO", "PEP", "JNJ", "PG", "CL"]) ids.push("target-" + symbol);
  for (const kind of ["watch", "candidate", "target", "oversold", "recovery"]) ids.push("event-" + kind);
  for (const id of ids) byId(id).disabled = !enabled;
}

function setSaveStatus(message) {
  byId("settings-status").textContent = message;
  byId("quick-save-status").textContent = message;
}

function hasProfileChanges() {
  if (!profileSavedSettings) return false;
  try { return JSON.stringify(readSettingsForm()) !== JSON.stringify(profileSavedSettings); }
  catch { return true; }
}

function markProfileChanges() {
  if (profileSaving) return;
  setSaveStatus(hasProfileChanges() ? "Salvestamata muudatused" : "Muudatusi ei ole.");
}

function refreshProfileView() {
  const loggedIn = Boolean(profileAccessCode);
  byId("account-button").textContent = loggedIn ? profileName() + " ▾" : "Logi sisse";
  byId("account-caption").textContent = profileName();
  byId("account-actions").hidden = !loggedIn;
  byId("profile-context").textContent = loggedIn ? profileName() + " · sinu sihthinnad ja valikud" : "Külalisvaade · oma sihthindade jaoks logi sisse";
  byId("open-settings").textContent = loggedIn || !profileApiUrl ? "Minu seaded" : "Logi sisse";
  byId("settings-heading").textContent = loggedIn ? profileName() + " · seaded" : "Minu seaded";
  byId("quick-target-form").hidden = Boolean(profileApiUrl && !loggedIn);
  byId("target-login").hidden = !profileApiUrl || loggedIn;
  if (state.data) renderResearch(state.data.stocks.find((stock) => stock.symbol === state.symbol));
}

function clearProfileSession() {
  try { sessionStorage.removeItem(PROFILE_SESSION_KEY); } catch {}
}

function resetProfile() {
  profileRequestVersion++;
  profileAccessCode = "";
  profileSavedSettings = null;
  profileSaving = false;
  byId("settings-save").textContent = "Salvesta profiil";
  byId("quick-target-save").textContent = "Salvesta muudatused";
  clearProfileSession();
  byId("profile-code").value = "";
  byId("profile-unlock").disabled = !profileApiUrl;
  byId("account-menu").open = false;
  setProfileEditing(false);
  // Clear the previous user's values before displaying another profile.
  researchSettings = structuredClone(researchPublishedSettings);
  for (const symbol of Object.keys(researchSettings.targets)) researchSettings.targets[symbol] = null;
  setSettingsFields(researchSettings);
  byId("profile-status").textContent = "Vali kasutaja ja sisesta profiili kood.";
  setSaveStatus("Sihthindade ja teavituste muutmiseks logi sisse.");
  refreshProfileView();
}

function showLogin() {
  byId("account-menu").open = false;
  byId("login-dialog").showModal();
}

function showProfileSettings() {
  byId("account-menu").open = false;
  if (profileApiUrl && !profileAccessCode) { showLogin(); return; }
  byId("settings-dialog").showModal();
}

function logoutProfile() {
  if (hasProfileChanges() && !confirm("Sul on salvestamata muudatusi. Kas logid välja ja loobud neist?")) return false;
  byId("settings-dialog").close();
  resetProfile();
  return true;
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

async function signInProfile(id, code) {
  const version = ++profileRequestVersion;
  byId("profile-unlock").disabled = true;
  byId("profile-status").textContent = "Login sisse…";
  try {
    const record = await profileRequest(id, code);
    if (version !== profileRequestVersion) return;
    profileAccessCode = code;
    researchSettings = structuredClone(record.settings);
    profileSavedSettings = structuredClone(record.settings);
    setSettingsFields(researchSettings);
    setProfileEditing(true);
    byId("profile-code").value = "";
    byId("profile-status").textContent = profileName() + " sisse logitud.";
    byId("profile-notice").hidden = true;
    try { sessionStorage.setItem(PROFILE_SESSION_KEY, JSON.stringify({ id, code })); }
    catch {
      byId("profile-notice").hidden = false;
      byId("profile-notice").textContent = "Brauser ei luba sessiooni salvestada. Vaate vahetamisel pead uuesti sisse logima.";
    }
    setSaveStatus(record.enabled ? "Salvestatud valikud on laaditud." : "Salvesta profiil, et aktiveerida selle teavitused.");
    refreshProfileView();
    byId("login-dialog").close();
  } catch (error) {
    if (version !== profileRequestVersion) return;
    clearProfileSession();
    byId("profile-status").textContent = error.message || "Sisselogimine ebaõnnestus.";
    throw error;
  } finally {
    if (version === profileRequestVersion) byId("profile-unlock").disabled = false;
  }
}

async function unlockProfile(event) {
  event.preventDefault();
  if (!profileApiUrl) return;
  const code = byId("profile-code").value.trim();
  if (code.length < 4) { byId("profile-status").textContent = "Sisesta vähemalt 4 märgiga profiili kood."; return; }
  try { await signInProfile(byId("profile-select").value, code); }
  catch { /* The login dialog displays the error and stays open. */ }
}

async function saveServerProfile(event) {
  event.preventDefault();
  if (!profileAccessCode || profileSaving) return;
  const version = profileRequestVersion;
  const id = byId("profile-select").value;
  profileSaving = true;
  setProfileEditing(false);
  setSaveStatus("Salvestan…");
  byId("settings-save").textContent = "Salvestan…";
  byId("quick-target-save").textContent = "Salvestan…";
  try {
    const settings = readSettingsForm();
    const record = await profileRequest(id, profileAccessCode, settings);
    if (version !== profileRequestVersion) return;
    researchSettings = structuredClone(record.settings);
    profileSavedSettings = structuredClone(record.settings);
    setSettingsFields(researchSettings);
    setSaveStatus("Salvestatud · " + new Date(record.updated_at).toLocaleTimeString("et-EE") + ". Valikud kehtivad mõlemas vaates.");
    refreshProfileView();
  } catch (error) {
    if (version === profileRequestVersion) setSaveStatus("Salvestamine ei õnnestunud: " + error.message + " Muudatused on salvestamata. Proovi uuesti.");
  } finally {
    if (version === profileRequestVersion) {
      profileSaving = false;
      byId("settings-save").textContent = "Salvesta profiil";
      byId("quick-target-save").textContent = "Salvesta muudatused";
      setProfileEditing(true);
    }
  }
}

function syncQuickTarget() {
  byId("target-" + state.symbol).value = byId("quick-target").value;
  markProfileChanges();
}

function setupProfileControls() {
  byId("account-button").addEventListener("click", (event) => {
    if (!profileAccessCode) { event.preventDefault(); showLogin(); }
  });
  byId("account-settings").addEventListener("click", showProfileSettings);
  byId("open-settings").addEventListener("click", showProfileSettings);
  byId("quick-settings").addEventListener("click", showProfileSettings);
  byId("target-login").addEventListener("click", showLogin);
  byId("login-close").addEventListener("click", () => byId("login-dialog").close());
  byId("settings-close").addEventListener("click", () => byId("settings-dialog").close());
  byId("profile-form").addEventListener("submit", unlockProfile);
  byId("profile-select").addEventListener("change", resetProfile);
  byId("profile-lock").addEventListener("click", logoutProfile);
  byId("profile-switch").addEventListener("click", () => { if (logoutProfile()) showLogin(); });
  byId("research-form").addEventListener("input", () => {
    byId("quick-target").value = byId("target-" + state.symbol).value;
    markProfileChanges();
  });
  byId("quick-target").addEventListener("input", syncQuickTarget);
  byId("quick-target-form").addEventListener("submit", (event) => { syncQuickTarget(); return saveResearchSettings(event); });
  window.addEventListener("beforeunload", (event) => {
    if (!hasProfileChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function loadProfileService() {
  try {
    const response = await fetch("profile-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Profiiliteenuse seadistust ei saanud laadida.");
    const config = await response.json();
    if (!config.api_url) {
      byId("profile-status").textContent = "Profiiliteenus pole ühendatud. Seaded töötavad ainult selles brauseris.";
      refreshProfileView();
      return;
    }
    const url = new URL(config.api_url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Profiiliteenuse aadress ei sobi.");
    if (!researchPublishedSettings) throw new Error("Päevaandmete seadistust ei saanud laadida.");
    profileApiUrl = url.origin;
    byId("profile-select").value = "user-1";
    byId("profile-select").disabled = false;
    byId("profile-code").disabled = false;
    byId("settings-save").textContent = "Salvesta profiil";
    byId("settings-export").hidden = true;
    byId("legacy-settings-note").hidden = true;
    let session = null;
    try { session = JSON.parse(sessionStorage.getItem(PROFILE_SESSION_KEY)); } catch {}
    resetProfile();
    if (session && ["user-1", "user-2", "user-3"].includes(session.id) && typeof session.code === "string" && session.code.length >= 4) {
      byId("profile-select").value = session.id;
      try { await signInProfile(session.id, session.code); }
      catch {
        byId("profile-notice").hidden = false;
        byId("profile-notice").textContent = "Sisselogimist ei saanud taastada. Logi paremal üleval uuesti sisse. " + byId("profile-status").textContent;
      }
    }
  } catch (error) {
    byId("profile-status").textContent = error.message + " Profiilide salvestamine pole saadaval.";
    byId("profile-notice").hidden = false;
    byId("profile-notice").textContent = byId("profile-status").textContent;
    // Never offer local saving as if it updated a configured remote profile.
    setProfileEditing(false);
  }
}
