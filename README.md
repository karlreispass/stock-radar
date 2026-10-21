# Stock Radar

Dividend Kings ja vaba valiku vaates saab tabelit järjestada RSI, päevamuutuse või
ostukandidaatide järgi. Nimekiri, valitud aktsia, ajavahemik, graafiku tüüp ja
sortimine taastatakse samas brauseris järgmisel avamisel.
Valitud aktsia hinnapäring toimub nähtaval vahelehel iga 15 sekundi järel;
kahe aasta päevaajalugu küsitakse kord 15 minuti jooksul. RSI ja tehniline hinnang
arvutatakse sellest ajaloost, jooksvat noteeringut näidatakse eraldi.
**Uuenda hindu** värskendab kohe kogu nimekirja ajaloo ning näitab edenemist ja
ebaõnnestunud sümboleid. Ettevõtete ühine nimekiri on `data/dividend-kings.json`;
seda kasutavad nii veebivaade kui ka `scripts/update_kings.py`.

Eestikeelne viie aktsia jälgija: Coca-Cola (KO), PepsiCo (PEP), Johnson & Johnson (JNJ),
Procter & Gamble (PG) ja Colgate-Palmolive (CL). Staatiline HTML/CSS/JavaScript, Python andmete jaoks.

## Kohalik käivitamine Windowsis

Repo sisaldab esialgset andmefaili, nii et lehte saab kohe vaadata. Andmete režiim ja kuupäev on veebilehel nähtavad:

```powershell
cd C:\repos-era\stock-radar
python -m http.server 8000 --bind 127.0.0.1
```

Ava http://localhost:8000. HTML-faili otse avamise asemel kasuta veebiserverit.
Veebivaate uuestilaadimise nupp loeb olemasoleva JSON-i uuesti; see ei käivita Yahoo päringut.

## Pärisandmed

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/update_data.py
```

Skript laadib Yahoo Finance'ist yfinance abil kahe aasta päevahinnad, arvutab RSI ja asendab
`data/stocks.json`. API võtit ei ole vaja. Kohalik andmefail muutub, commit'i seda ainult soovi korral.
Näidisandmete taastamine: `python scripts/update_data.py --demo`.

Andmeallikas võib päringuid piirata või katkeda. Kolm katset aktsia kohta; kui mõni aktsia ebaõnnestub,
ei asendata olemasolevat andmefaili. Avaldamise töövoog ebaõnnestub ja eelmine avaldatud veeb jääb alles.
Pärisandmete töövoog ei lähe vea korral vaikselt näidisandmetele üle.

## GitHub Actions ja Pages

1. Lükka failid GitHubi `main` harusse.
2. Ava **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Ava **Actions → Refresh data and deploy Pages → Run workflow**, kui esimene push jõudis
   enne Pagesi lubamist ebaõnnestuda.
4. Veebilehe aadress on tavapärase seadistusega https://karlreispass.github.io/stock-radar/.
   See aadress hakkab tööle alles pärast edukat avaldamist.

GitHub Free puhul peab repo Pagesi jaoks olema avalik; privaatse repo puhul on vaja sobivat tasulist paketti.
Töövoog kasutab GitHubi automaatset tokenit; eraldi salasõnu ega API võtmeid pole vaja seadistada.
`github-pages` keskkonna kaitse võib nõuda GitHubis avaldamise kinnitamist.

- **Checks**: pull request, push `main` harusse või käsitsi. RSI testid, JS süntaks, näidisandmete genereerimine.
- **Refresh data and deploy Pages**: push `main` harusse, käsitsi või E–R kell 22:25 UTC
  (Eestis talvel 00:25, suvel 01:25 järgmisel kuupäeval).
- Päevased andmed lisatakse avaldamise artefakti. Robot ei tee reposse andme-commit'e.
- Ajastatud käivitused kasutavad vaikimisi haru ning võivad GitHubi koormuse tõttu hilineda.
  Avalikus repos võidakse need pärast 60 päeva tegevusetust peatada.
- Kontrollide töövoog ei laadi turuandmeid; need laaditakse avaldamisel.

GitHubi juhend: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

## Arvutus ja tõlgendamine

- RSI periood: **14 hinnamuutust**, esialgu lihtkeskmised, seejärel Wilderi silumine.
- Andmed on dividendide ja split'idega korrigeeritud sulgemishinnad (USD); ajaloolised hinnad
  võivad seetõttu erineda tolle päeva tegelikust noteeringust ja ajas tagasiulatuvalt muutuda.
- Tänane päev võetakse kaasa alles pärast kella 17:00 New Yorgis, et vältida poolelioleva
  kauplemispäeva kasutamist. Turupühadel jääb viimaseks eelmine olemasolev kauplemispäev.
- Kõik signaalid ja päevamuutus kasutavad neid korrigeeritud hindu.
- **Jälgimisala:** RSI < 40. **Alla 30:** RSI < 30. **Taastumine:** eelmine RSI < 30 ja viimane RSI >= 30.
  **Üle 70:** RSI > 70. Vahemikus 40–70 neutraalne; 30 kuni alla 40 jälgimisala.
- Muutumatu hinna erijuht: RSI 50; ainult tõusude korral 100; ainult languste korral 0.
- 30 päeva vahemik tähendab 30 kalendripäeva viimase andmepäeva suhtes, mitte 30 kauplemispäeva.
- Vanema kui nelja kalendripäeva andmekuupäeva puhul kuvab veeb aegumise hoiatuse.
- Andmed ei ole reaalajas. Näidisrežiim on alati selgelt märgitud.
- Graafikute all on päevaandmete tabel; signaal ei sõltu valitud graafiku ajavahemikust.

RSI ei näita ettevõtte õiglast väärtust ega ennusta kuu madalaimat hinda.
Tegemist on tehnilise jälgijaga, mitte personaalse investeerimissoovitusega.
Aktsiate nimekiri on sektori poolest koondunud. Ajaloolise võrdluse eeldused ja piirangud on allpool.

yfinance on mitteametlik teek, mis ei ole Yahoo heaks kiidetud ega Yahoo'ga seotud.
See on mõeldud uurimiseks ja õppimiseks; Yahoo andmete kasutamisel arvesta Yahoo tingimuste ning
isikliku kasutuse piirangutega. Äriliseks või laiemaks avalikuks teenuseks kontrolli andmelitsentsi
ja vajadusel vaheta litsentsitud andmeallika vastu.

## Kontrollid

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --check app.js
```

Windowsi Python vajab New Yorgi ajavööndi jaoks `tzdata` paketti (sisaldub requirements.txt-is).
Ubuntu GitHub Actionsi keskkonnas on süsteemi ajavööndiandmed juba olemas.

## GitHubi teavitused ja meilid

Pärast edukat Pagesi avaldamist loob eraldi `notify` töö uute aktsiasignaalidega GitHubi Issue. Laiendatud valikud on kirjeldatud allpool sihthindade ja ajaloolise võrdluse osas.
Iga kauplemispäeva signaalid koondatakse ühte Issue'sse pealkirjaga **Aktsiasignaalid · AAAA-KK-PP**.

- **Alla 30:** eelmine RSI >= 30 ja viimane RSI < 30.
- **Taastumine:** eelmine RSI < 30 ja viimane RSI >= 30.
- Püsivalt alla 30 olev RSI ei tekita iga päev uut signaali.
- Issue sisaldab ettevõtet, kauplemispäeva, korrigeeritud hinda USD-des, eelmist ja viimast RSI-d ning linki veebilehele.

Teavitused on päevased, mitte reaalajas. Kontrollitakse ainult viimast kauplemispäeva.
Näidisandmetest, tulevase kuupäevaga või üle nelja kalendripäeva vanadest andmetest teavitusi ei looda.

### Kuidas meiliteavitused sisse lülitada

1. Kontrolli, et repos oleks **Issues** lubatud.
2. Ava repo GitHubis ja vali **Watch → Custom → Issues → Apply**.
   Sobib ka **Watch → All Activity**, kuid sellega võib tulla rohkem teavitusi.
3. Ava https://github.com/settings/notifications ja luba **Watching** teavituste jaoks **Email**.
4. Kontrolli, et GitHubi kontol oleks kinnitatud meiliaadress ning repo teavituste aadress oleks õige.
5. Pärast commit'i ja push'i saab töövoo käivitada ka
   **Actions → Refresh data and deploy Pages → Run workflow** kaudu.

GitHub saadab Issue loomise ja uute kommentaaride teavitused sinu GitHubi teavitussätete järgi.
Meilide kättetoimetamist juhib GitHub; rakendus ei saada ise kirju.
Eraldi meiliserverit, lisatud salasõnu ega käsitsi loodud API võtit pole vaja.
GitHub Actions annab `GITHUB_TOKEN` väärtuse automaatselt ning töövoog annab ainult
`notify` tööle `issues: write` õiguse. Organisatsiooni piirangud võivad selle õiguse keelata.

Juhendid:
- https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
- https://docs.github.com/en/actions/tutorials/authenticate-with-github_token

### Korduste vältimine

Enne loomist kontrollitakse sama päeva Issue olemasolu, sealhulgas suletud Issue'sid.
Varasemad signaalid tuvastatakse Issue sisu ja kommentaaride peidetud märgiste järgi.
Kui sama päeva kohta saabub hiljem uus signaal, lisatakse see olemasolevale Issue'le kommentaarina.
See säilitab ühe Issue päeva kohta ning võimaldab GitHubil saata ka lisateavituse.

Saatmisajalugu püsib GitHubis; kohalikku ajaloo faili ega Actionsi vahemälu pole vaja.
Ära eemalda automaatseid peidetud märgiseid Issue või kommentaari toorsisust.
Issue või märgiste kustutamine võib põhjustada sama signaali uuesti avaldamise.
Kui GitHubi päring ebaõnnestub, peatub teavituste töö veaga ning seda saab uuesti käivitada.
Veebileht on selleks hetkeks juba avaldatud ja jääb tööle.

### Kohalik eelvaade ilma teavitusi loomata

```powershell
python scripts/send_notifications.py --dry-run
```

Eelvaade ei vaja tokenit, ei ühendu GitHubiga ega loo Issue'sid või kommentaare.
See näitab viimase päeva võimalikke signaale, arvestamata varem avaldatud teavituste ajalugu.
Kui signaale ei ole, kuvatakse sellekohane teade.
Testides on kõik GitHubi API päringud simuleeritud; päris Issue'sid ei looda.


## Sihthinnad, trend ja ajalooline võrdlus

Mõlemal lehel on **Ostuplaan ja ajalooline võrdlus**. Seal saad sisestada sihthinnad,
valida teavitused ning muuta võrdluse tehingukulu ja igakuist sissemakset.
Sihthindu pole ette määratud. **Rakenda selles brauseris** salvestab ainult sinu brauseri
valikud; see ei muuda GitHub Actionsi teavitusi.

Automaatika seadistamiseks vajuta **Laadi settings.json alla**, asenda repo juurkaustas
olev samanimeline fail, tee commit ja push. Võid faili ka otse GitHubis muuta.
Teavitused kasutavad alati repos olevat seadistust, ka siis, kui brauser on suletud.
Tehingukulu on baaspunktides ühe tehingu poole kohta: 10 = 0,10%; see on muudetav
tasude ja hinnavahe hinnang. Kuumakse on võrdluse sisend, mitte automaatne maksekorraldus.

Uued teavitused:
- RSI langeb esimest korda vähemalt 40 pealt alla 40.
- Võimalik ostukandidaat: RSI on viimasel viiel kauplemispäeval olnud alla 40,
  viimase päeva RSI on kõrgem kui viis kauplemispäeva tagasi ning hind ületab
  viimasel päeval 20 päeva keskmise alt üles. Kõik tingimused peavad täituma.
- Sihthind: eelmine korrigeerimata sulgemishind oli sihist kõrgem, viimane on sihiga
  võrdne või madalam. Päevasisest puudutust ei jälgita. Esialgu juba sihist madalamal
  püsimine ei loo iga päev uut teadet.
- Senised RSI alla 30 ja tagasi vähemalt 30 peale teavitused jäävad valitavaks.
- Sama kauplemispäeva uued sündmused koondatakse ühte Issue'sse; varem avaldatud
  sündmusi ei korrata, ka suletud Issue korral.

Sihthinna kontroll vajab uut, `quote_close` välja sisaldavat andmefaili.
See tekib järgmisel edukal Actionsi andmelaadimisel. Korrigeeritud `close` jääb
RSI, hinnakeskmiste ja ajaloolise võrdluse aluseks. 50 ja 200 päeva hinnakeskmised
on lisatud mõlema lehe detailidesse ning päevavaate graafikule.
Need ei muuda olemasolevat kolme tingimusega ostukandidaadi reeglit.

Andmete vananemise märguanne tekib üle nelja kalendripäeva vanuse andmekuupäeva korral.
Andmelaadimise või Pagesi avaldamise vea korral käivitub eraldi `health` töö isegi siis,
kui tavaline `notify` jäi vahele. Tervisemärkused koondatakse eraldi püsivasse Issue'sse.
Sama vana andmekuupäeva ei teatata korduvalt; töövoo tõrkest saadetakse kuni üks
märkus UTC päeva kohta. Suletud tervise-Issue avatakse uue sündmuse korral.
Kui Actionsi ajastus ise ei käivitu, ei saa see automaatika sellest ise teavitada.

### Mida ajalooline võrdlus mõõdab?

- Kasutatakse olemasolevat ligikaudu kahe aasta ajalugu. Esimesed 200 hinnapäeva on eellugu.
- Signaal arvutatakse ainult sel hetkel teada olnud hindadest. Ost toimub järgmisel
  olemasoleval kauplemispäeval sulgemishinnaga, mitte signaalipäeva juba teada oleva hinnaga.
- Näidatakse 5, 20 ja 60 kauplemispäeva hoidmise keskmist netomuutust, positiivsete
  juhtumite osakaalu ja halvimat ostujärgset sulgemishinna langust. Lõpetamata
  hoidmisperioodid jäetakse välja. Juhtumid võivad kattuda ega ole sõltumatud.
- Kõrval võrreldakse signaali ootamist igakuise ostmisega. Mõlemad saavad samadel
  kuupäevadel sama sissemakse, raha lisandub kuu esimesel olemasoleval kauplemispäeval.
  Signaalistrateegia ostab kogu kogunenud raha eest; regulaarne strateegia ostab kohe.
  Lõppväärtus sisaldab kasutamata raha ja aktsiate müügikulu.
- Mõlemal arvestatakse ostu- ja müügikulu. Lubatud on murdosad; raha intressi, makse
  ja valuutavahetust ei modelleerita. Korrigeeritud hinnad arvestavad dividende;
  dividende eraldi juurde ei lisata.
- Näidisandmete võrdlus on selgelt märgitud. Praeguse viie aktsia ja sama andmestiku
  peal tehtud võrdlus ei tõesta strateegia tulevast edu ega väldi valikukallutatust.
- Sihthinnad ega võrdlus ei loo maaklerile ordereid.

Kohalikud lisakontrollid:

```powershell
node --test tests/analysis.test.cjs
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
```

Teavituste eelvaade: `python scripts/send_notifications.py --dry-run`.
Tõrketeate eelvaade: `python scripts/send_notifications.py --failure --dry-run`.
Mõlemad on eelvaated; päris teavitused saadab pärast avaldamist Actions.

## Kolm salvestatavat profiili

Veebivaated toetavad profiile **Kasutaja 1**, **Kasutaja 2** ja **Kasutaja 3**.
Taustateenus vajab omaniku ühekordset paigaldust: [juhend](backend/README.md).
Pärast ühendamist saab kasutaja oma koodiga veebis sihthindu salvestada, ilma failide
eksportimise või GitHubi kontota. Kõigi profiilide teavitused lähevad ühisesse Issue-voogu.

Profiili avamiseks vajuta paremal üleval **Logi sisse**. **Minu seaded** sisaldab
sihthindu, teavitusi ja võrdluse valikuid; valitud aktsia sihthinda saab muuta ka
graafiku juures. Sisselogimine püsib sama vahelehe mõlema vaate vahel ja
värskendamisel. **Logi välja** lõpetab sessiooni; salvestatud seaded jäävad teenusesse.
