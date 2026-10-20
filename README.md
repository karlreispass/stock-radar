# Stock Radar

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
- **Alla 30:** RSI < 30. **Taastumine:** eelmine RSI < 30 ja viimane RSI >= 30.
  **Üle 70:** RSI > 70. Muul juhul neutraalne.
- Muutumatu hinna erijuht: RSI 50; ainult tõusude korral 100; ainult languste korral 0.
- 30 päeva vahemik tähendab 30 kalendripäeva viimase andmepäeva suhtes, mitte 30 kauplemispäeva.
- Vanema kui nelja kalendripäeva andmekuupäeva puhul kuvab veeb aegumise hoiatuse.
- Andmed ei ole reaalajas. Näidisrežiim on alati selgelt märgitud.
- Graafikute all on päevaandmete tabel; signaal ei sõltu valitud graafiku ajavahemikust.

RSI ei näita ettevõtte õiglast väärtust ega ennusta kuu madalaimat hinda.
Tegemist on tehnilise jälgijaga, mitte personaalse investeerimissoovitusega.
Aktsiate nimekiri on sektori poolest koondunud. Ajaloolist tootluse võrdlust esimeses versioonis ei ole.

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

Pärast edukat Pagesi avaldamist loob eraldi `notify` töö uute RSI-signaalidega GitHubi Issue.
Iga kauplemispäeva signaalid koondatakse ühte Issue'sse pealkirjaga **RSI-signaalid · AAAA-KK-PP**.

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

