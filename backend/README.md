# Kolme profiili taustateenus

Teenuse kasutajad on **Kasutaja 1**, **Kasutaja 2** ja **Kasutaja 3**.
Nad ei vaja GitHubi, Cloudflare'i ega Supabase'i kontot. Omanik loob ühe Cloudflare
Workeri ning KV salvestuse. Kõigi profiilide uued signaalid lähevad samasse
GitHubi päeva-Issue'sse, kus on näha ka profiili nimi.

## Ühekordne paigaldus omanikule

1. Loo konto https://dash.cloudflare.com/sign-up ja logi sisse.
2. Ava PowerShell projekti juurkaustas:

```powershell
cd C:\repos-era\stock-radar
npx.cmd --yes wrangler@4 login
npx.cmd --yes wrangler@4 kv namespace create PROFILES --config backend/wrangler.jsonc
```

3. Kopeeri loodud KV namespace'i ID faili `backend/wrangler.jsonc`,
   `kv_namespaces[0].id` väljale senise kohatäitja asemele. See ID ei ole saladus.
   Wrangler võib pakkuda konfiguratsiooni automaatset täiendamist; kontrolli, et
   binding oleks täpselt `PROFILES`.
4. Avalda Worker:

```powershell
npx.cmd --yes wrangler@4 deploy --config backend/wrangler.jsonc
```

5. Loo paroolihalduriga kolm erinevat vähemalt 12 märgiga profiilikoodi
   (soovitatavalt 16–32 juhuslikku ASCII tähte/numbrit) ning neist erinev vähemalt
   32 märgiga automaatikavõti. Järgmised käsud küsivad väärtusi interaktiivselt:

```powershell
npx.cmd --yes wrangler@4 secret put PROFILE_1_CODE --config backend/wrangler.jsonc
npx.cmd --yes wrangler@4 secret put PROFILE_2_CODE --config backend/wrangler.jsonc
npx.cmd --yes wrangler@4 secret put PROFILE_3_CODE --config backend/wrangler.jsonc
npx.cmd --yes wrangler@4 secret put AUTOMATION_TOKEN --config backend/wrangler.jsonc
```

   Anna iga kasutaja kood ainult vastava profiili kasutajale. Automaatikavõtit
   kasutajatele ei anta. Koode ei salvestata reposse ega brauseri püsisalvestusse.
   Teenus vastab enne kõigi binding'ute ja saladuste seadistamist kontrollitud veaga.
6. GitHubis **Settings → Secrets and variables → Actions**:
   - **Variables**: lisa `PROFILE_API_URL` väärtuseks Workeri HTTPS-juuraadress,
     näiteks `https://stock-radar-profiles.SINU-ALAMDOMEEN.workers.dev`.
     Ära lisa lõppu `/v1/profiles`.
   - **Secrets**: lisa `PROFILE_API_TOKEN`, mille väärtus on täpselt sama
     mis Cloudflare'i `AUTOMATION_TOKEN`. Seda võtit veebilehe koodi ei lisata.
7. Commit'i ja push'i koodimuudatused. Käivita GitHubis
   **Actions → Refresh data and deploy Pages → Run workflow**.
   Avaldamine kirjutab veebilehele ainult avaliku teenuse aadressi.
8. Ava Workeri `/health`: valmis teenus vastab `{"ready":true}`.
   Ava seejärel Stock Radar, vali profiil, sisesta selle kood ja salvesta valikud.
   Alles esimene salvestamine aktiveerib selle profiili teavitused.

Erineva veebidomeeni kasutamisel muuda Workeri `ALLOWED_ORIGIN` väärtust.
See on veebilehe päritolu ilma teekonnata: praegu `https://karlreispass.github.io`.
Profiiliteenust ei saa siinsetest tööriistadest enne sinu Cloudflare'i konto
ühendamist avaldada. Kontot ega saladusi need failid ise ei loo.

## Kasutamine

- Vali oma profiil, sisesta kood ja vajuta **Ava profiil**.
- Muuda sihthindu või muid valikuid ning vajuta **Salvesta profiil**.
  Faili eksporti ega commit'i kasutajal vaja ei ole.
- Profiilivahetus ja **Lukusta** tühjendavad koodi mälust ning lukustavad vormi.
  Uuel lehe avamisel tuleb kood uuesti sisestada.
- Profiilid on eraldi. Mitme inimese sama profiili muutmisel jääb kehtima
  viimane salvestatud versioon. KV muudatus võib teises asukohas nähtavaks saada
  ligikaudu minuti jooksul; järgmine päevane kontroll kasutab teenuses olevaid andmeid.
- Kõigi profiilide teavitused on ühised ja sisaldavad profiilinime.
  Avalikus repos on teavitustes avaldatud hinnad nähtavad ka teistele.
- GitHubi Watch vajab teavituste saajal GitHubi kontot. Ilma GitHubi kontota
  kasutaja saab profiili kasutada; e-kirju talle see lahendus otse ei saada.
- Kui teenus on seadistatud, kuid ei vasta, ei kasutata teavituseks varasemaid
  kohalikke sihthindu. `notify` ebaõnnestub ja ühine tervisemärguanne annab tõrkest teada.
- Kui `PROFILE_API_URL` ja `PROFILE_API_TOKEN` on mõlemad seadistamata,
  jääb senine brauseri + repo `settings.json` lahendus tööle. Veeb ütleb,
  et taustateenus pole ühendatud. Osaliselt seadistatud automaatika ebaõnnestub
  selge veaga ega teeskle edukat profiilide laadimist.

## Kontrollid

```powershell
node --test tests/analysis.test.cjs tests/profiles.test.cjs
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
npx.cmd --yes wrangler@4 deploy --dry-run --config backend/wrangler.jsonc
```

Worker kasutab vaid standardset JavaScripti, Web Crypto't, KV-d ja Rate Limiting
binding'ut. Brauseri kood ei sisalda GitHubi kirjutusvõtit ega automaatikavõtit.
Automaatikavõti saab ainult kõigi profiilide seadistusi lugeda; iga profiili
kood saab lugeda ja muuta ainult selle profiili valikuid.

Ametlikud juhendid:
- https://developers.cloudflare.com/kv/get-started/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
