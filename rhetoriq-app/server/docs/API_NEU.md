# API-Erweiterungen (Zweig redesign)

Alle Routen sind additiv. Bestehende Routen und Antwortformate bleiben unverändert (Ausnahmen mit zusätzlichen Feldern sind markiert).
Auth: `Authorization: Bearer <JWT>`. "Beraterin" = Token mit role advisor. Fehlerformat: `{ "error": "..." }`.
Das Schema entsteht beim ersten Aufruf bzw. beim Serverstart (`lib/schemaRedesign.js`, nur `IF NOT EXISTS`).

## Onboarding-Entwürfe (S1)

Alle Routen: nur Beraterin (ohne Token 401, Klient 403).

| Methode | Pfad | Zweck |
|---|---|---|
| POST | /api/onboarding-drafts | Entwurf anlegen, optional `inquiry_id` (Vorbefüllung aus der Anfrage, Anfrage wird `workshop_offen`) |
| GET | /api/onboarding-drafts | Liste (ohne vorschlaege und briefing) |
| GET | /api/onboarding-drafts/:id | ein Entwurf komplett |
| PUT | /api/onboarding-drafts/:id | Teilupdate, nur übergebene Felder |
| DELETE | /api/onboarding-drafts/:id | löschen (inkl. noch nicht zugeordneter Dateien) |

Felder: `firma, kontakt, email, webseite, sektor` (kmu, hotellerie, capital, bildung, nonprofit, tech, beratung), `anrede` ('du'|'sie'), `titel` ('Frau'|'Herr'|''), `workshop_datum` (Text), `schritt` (0 bis 20), `module` (Liste von Modulnamen, unbekannte fallen weg), `vorschlaege`, `briefing` (Objekte, max. 300 KB), `status` ('workshop_offen'|'bereit'|'abgeschlossen').

```
POST /api/onboarding-drafts
{ "inquiry_id": 12 }
201 { "id": 3, "inquiry_id": 12, "firma": "Muster GmbH", "kontakt": "Bea Muster", "email": "bea@muster.ch",
      "anrede": "sie", "schritt": 0, "module": [], "vorschlaege": {}, "briefing": {}, "status": "workshop_offen",
      "client_id": null, "created_at": "...", "updated_at": "..." }

PUT /api/onboarding-drafts/3   { "schritt": 2, "module": ["Text Generator", "Risiko-Scan"], "sektor": "kmu" }
```

Erweiterung bestehender Route: `GET /api/inquiries` liefert zusätzlich `draft_id` (neuester Entwurf der Anfrage oder null). Status `workshop_offen` und `klient` erscheinen in der Liste (nur `archiviert` wird ausgeblendet). Wortlaut der Anfrage-Mails unverändert.

## Webseiten-Scan (S2)

`POST /api/onboarding-drafts/:id/scan` (Beraterin, 30 pro Stunde). Lädt `webseite` des Entwurfs mit SSRF-Schutz (`lib/safeFetch.js`: nur http/https auf Port 80/443, keine internen Adressen auch nach Weiterleitungen, 10 s Timeout, 2 MB, max. 3 Weiterleitungen), lässt Claude ein Briefing erstellen und speichert es in `vorschlaege` und `briefing`.

```
200 { "ok": true, "quelle": "https://keller.example/",
      "vorschlaege": { "blick": [], "kommunikation": [], "hypothesen": [], "eroeffnung": [], "texte": [], "fragen": [],
                       "module": [["Text Generator", "Begründung"]], "widerstaende": [], "material": [] },
      "draft": { ... } }
```
Fehler: 400 keine Webseite im Entwurf, 404 Entwurf, 422 Webseite nicht ladbar oder zu wenig Text, 502 KI nicht erreichbar oder Antwort nicht lesbar.
Module sind auf die 14 bekannten Namen gefiltert. Alles ist im Prompt als Hypothese gekennzeichnet.

## Workshop-Mappe (S3)

`POST /api/onboarding-drafts/:id/workshop-docs` (Beraterin). Body optional `{ "branche": "...", "zielgruppen": "..." }` (Teil A des Erfassungsbogens; sonst aus briefing.branche/zielgruppen, Branche fällt auf den Sektornamen zurück).
Erzeugt `0_Briefing_<Firma>.docx`, `1_Einfuehrungsgespraech_<Firma>.docx`, `2_Workshop_Leitfaden_<Firma>.docx`, `3_Erfassungsbogen_<Firma>.docx` (kein Python; Vorlagen in `server/templates/workshop`) und legt sie im Ordner `workshop` des Entwurfs ab. Erneutes Erzeugen ersetzt die Dateien.
```
200 { "ok": true, "files": [ { "id": 7, "draft_id": 3, "client_id": null, "folder": "workshop", "name": "0_Briefing_Muster_GmbH.docx", "mime": "...", "size": 10322, "created_at": "..." }, ... ] }
```
Die Vorab-Mail gehört nicht dazu (`POST /api/inquiries/:id/vorab`). Download über `/api/files/:id/download` oder gesamt über `/api/files/zip?draft_id=3`.

## Ablage (S4)

Ordner: `entwuerfe`, `workshop`, `unterlagen`, `gesendet`. Beraterin: alles. Eingeloggter Klient: nur Lesen der eigenen Dateien im Ordner `unterlagen` (fremde oder andere Ordner: Liste 403, Download 404).

| Methode | Pfad | Rechte | Zweck |
|---|---|---|---|
| GET | /api/files?client_id=\|draft_id=[&folder=] | Beraterin; Klient ohne Parameter oder mit eigener client_id | Liste ohne Inhalt |
| GET | /api/files/:id/download | Beraterin; Klient (eigene unterlagen) | Datei, immer als Anhang |
| GET | /api/files/zip?client_id=\|draft_id= | wie Liste | alles als ZIP (Unterordner je Ordner) |
| POST | /api/files | Beraterin | Upload |
| DELETE | /api/files/:id | Beraterin | löschen |

Upload multipart: Felder `file`, `client_id` oder `draft_id`, `folder` (Standard `unterlagen`), `note`. Bis 10 MB (sonst 413).
Upload JSON: `{ "client_id": 5, "folder": "unterlagen", "name": "Strategie.pdf", "mime": "application/pdf", "dataBase64": "...", "note": "" }`. Wegen des 5-MB-Body-Limits des Servers praktisch bis rund 3,5 MB Dateigrösse; grössere Dateien per multipart.
Ausführbare Dateitypen (exe, bat, sh, ...) werden abgelehnt. Antwort 201: Zeile ohne `data` (`id, client_id, draft_id, folder, name, mime, size, note, created_at`).

## Entwurf sichern und Kopie beim Senden (S5)

`POST /api/reviews/:id/save-draft` (Beraterin) Body `{ "text": "...", "moduleLabel": "optional" }` speichert `<Modul> · <TT.MM.JJJJ>.txt` im Ordner `entwuerfe` des Klienten der Anfrage. 201 mit Dateizeile. 400 leerer Text oder Anfrage ohne Klient, 404 unbekannt.
Bestehendes `PUT /api/reviews/:id` (Senden, `send` nicht false) legt zusätzlich eine Kopie im Ordner `gesendet` ab; Fehler dort werden nur geloggt, Antwort und Verhalten bleiben gleich.

## Auftrag an Beraterin (S6)

Bestehendes `POST /api/reviews` akzeptiert zusätzlich `instruction` (Text, max. 4000) und `dueAt` (ISO-Zeitpunkt, nicht in der Vergangenheit; sonst 400). Ohne `dueAt` gilt jetzt + 3 Stunden. Antwort und `GET /api/reviews` enthalten zusätzlich `instruction` und `due_at`. Die Mail an die Beraterin enthält Auftrag und Frist, sobald `instruction` oder `dueAt` mitgegeben wurden; sonst ist der Mailtext identisch zu bisher.

## Klient aus Entwurf anlegen (S7)

`POST /api/onboarding-drafts/:id/finish` (Beraterin) Body `{ "privacyAcknowledged": true }` (Pflicht, wie bei `POST /api/clients`), optional `clientType` ('company'|'individual'), `lastName`.
Voraussetzung: Firma und gültige E-Mail im Entwurf. Ablauf: Klient anlegen (gleiche Logik wie `POST /api/clients`, `lib/clientCreate.js`), `enabled_modules` aus den gewählten Modulen (Brand Voice immer), Entwurfsdateien dem Klienten zuordnen, Entwurf `abgeschlossen`, Anfrage `klient`, Einladung per Mail (Du oder Sie nach `anrede`, Texte in `lib/onboardingMails.js`) mit Link `<APP_URL>/setup?t=<token>`, 7 Tage gültig (bestehender Ablauf onboarding_tokens und `/api/setup/verify|complete`).
```
201 { "ok": true, "client": { "id": 9, "name": "Keller Bau AG", "email": "...", "slug": "...", "enabled_modules": ["brand-voice","text-gen"] },
      "inviteSent": true, "inviteExpiresAt": "2026-10-15T...Z", "draft": { ... } }
```
`inviteSent:false` heisst: Klient existiert, die Mail konnte nicht eingereiht werden (dann `POST /api/clients/:id/send-welcome` nutzen, 48 Stunden). 409 bei erneutem Abschluss.
Zuordnung Modulname zu Schlüssel: Brand Voice brand-voice, Text Generator text-gen, Vorher / Nachher before-after, Varianten-Generator vs-gen, Situations-Variante vs-cal, Kommunikations-Profil profiling, Feedback Writer review, Wertschätzung recognition, Meeting-Vorbereitung pre-meeting, Risiko-Scan risk, Klarheits-Check actionability, Notizen zu Aufgaben thread, Einwand-Training sparring, Debrief debrief.

## Ansicht des Klienten, nur lesend (S8)

`POST /api/advisor/view-as/:clientId` (Beraterin, nur eigene Klienten) schreibt in `access_log` und liefert
```
200 { "token": "<JWT 30 Min>", "expiresInSeconds": 1800, "client": { "id": 9, "name": "...", "industry": "...", "advisorName": "..." } }
```
Das Token hat die Form des Klient-Tokens plus `viewAs:true, readOnly:true, viewedBy`. Die Plattform lädt damit wie in der Klient-Sicht (gleiche Antworten wie `client-login`). Mit einem Token mit `readOnly:true` sind nur GET, HEAD und OPTIONS erlaubt; alle anderen Methoden liefern 403 `{"error":"Nur Ansicht"}` (globale Middleware `middleware/readOnly.js`, vor allen Routen). Das Token verfällt zusätzlich wie jedes Klient-Token, wenn `token_version` des Klienten steigt.
`GET /api/advisor/view-as-log/:clientId` (Beraterin) liefert `[ { "id", "advisor_id", "advisor_name", "client_id", "started_at" } ]`, neueste zuerst.

## Hilfe-Chat (S9)

`POST /api/help-chat` (eingeloggt, Beraterin oder Klient) `{ "question": "Wie sende ich einen Text?" }` liefert `200 { "answer": "..." }`. Frage 1 bis 600 Zeichen (sonst 400), 10 Fragen pro Minute und Nutzer (429), 502 wenn die KI nicht antwortet. Die Frage wird nicht gespeichert. Ein Lese-Token (Ansicht) kann nicht fragen (POST gesperrt).

## Häufigste Textarten (S10)

`GET /api/clients/:id/top-modules` (Klient nur eigene id, sonst 403; Beraterin nur eigene Klienten, sonst 404) liefert die Top 3 der letzten 30 Tage:
`[ { "module": "text-gen-email", "count": 4 }, { "module": "review", "count": 3 } ]`. Text-Generator-Kacheln erscheinen unter ihrem Kachelschlüssel (analyses.feedback_key), alles andere unter analyses.module.

## Neue Umgebungsvariablen

Keine. (Genutzt werden die vorhandenen: JWT_SECRET, ANTHROPIC_API_KEY, APP_URL.)

## Tests

`cd rhetoriq-app/server && npm test` (Node Test Runner, `node --test`). Die neuen Tests (`test/redesign.test.js`) laufen gegen pg-mem und Attrappen für KI, Mail und Brevo, ohne echte Aufrufe.
