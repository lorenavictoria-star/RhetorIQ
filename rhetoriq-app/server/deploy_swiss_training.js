const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://rhetoriq_db_user:qXv6yidawqN18C7HuE7pb7ajhygnkJHQ@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq_db',
  ssl: { rejectUnauthorized: false }
});

const ADVISOR_ID = 1;

async function bv(content) {
  const r = await pool.query(
    `INSERT INTO company_memory (client_id, memory_type, content) VALUES (NULL,'brand_voice',$1) RETURNING id`,
    [content]
  );
  return r.rows[0].id;
}

async function ex(module, label, tag, input, output, shareable = true, rating = 5) {
  const r = await pool.query(
    `INSERT INTO module_examples
       (advisor_id, module_key, label, industry_tag, input_text, output_text,
        rating, source_client_id, is_cross_client_shareable, auto_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,false) RETURNING id`,
    [ADVISOR_ID, module, label, tag, input, output, rating, shareable]
  );
  console.log(`  ✓ #${r.rows[0].id} [${module}] ${label}`);
}

async function main() {

// ════════════════════════════════════════════════════════════
// 1. MIGROS — volksnah, direkt, Du-Form, Schweizer Alltagsmarke
// ════════════════════════════════════════════════════════════
console.log('\n── Migros ──');
await bv(`MIGROS — Detailhandel / FMCG, Schweiz

KERNIDENTITÄT: Genossenschaft, nicht Aktiengesellschaft. Gehört dem Schweizer Volk.
Slogan: «Für Sie — von uns» / «Echt gut»

ANREDE: Du-Form — konsequent, warm, einladend. Nie formell.

SPRACHSTIL:
- Kurze Sätze, alltagsnahe Sprache, keine Anglizismen
- Positiv und lösungsorientiert — kein Negativmarketing
- Nachhaltigkeit als Selbstverständlichkeit, nicht als Werbeversprechen
- Zahlen und Fakten eingebettet in Alltagsrelevanz: «Jede zweite Schweizerin kauft bei uns ein»
- Humor: freundlich, nie ironisch oder provokativ

THEMEN-GEWICHTUNG:
- Frische, Qualität, Herkunft (Schweizer Produkte bevorzugt)
- Nachhaltigkeit: Engagement (kein Greenwashing-Ton)
- Mitarbeitende: Wertschätzung, Vielfalt, Ausbildung
- Gemeinschaft: «Zusammen sind wir Migros»

CORPORATE COMMS:
- Medienmitteilungen: klar, strukturiert, mit konkreten Zahlen
- Mitarbeiterkommunikation: per Du, warm, motivierend
- Kundenkommunikation: einladend, unkompliziert, hilfreich

NICHT-MIGROS: Keine Superlative ohne Beleg («das Beste»), kein Behördendeutsch, keine Distanz`);

await ex('text-gen', 'Migros – Mitarbeitenden-Newsletter Nachhaltigkeitsprojekt',
  'Detailhandel / Interne Kommunikation',
  `Schreibe einen kurzen Beitrag (150 Wörter) für den Mitarbeitenden-Newsletter der Migros. Thema: Das neue Rückgabesystem für Plastikverpackungen startet nächsten Monat in allen Filialen.

Tonalität: Du-Form, motivierend, stolz — Mitarbeitende sollen sich als Teil der Lösung fühlen, nicht als Befehlsempfänger. Konkrete Infos zum Ablauf, aber leicht und lesbar.`,
  `Ab nächstem Monat sind wir einen grossen Schritt weiter: In allen Filialen startet das neue Rückgabesystem für Plastikverpackungen.

Du wirst es als Erste erleben, bevor unsere Kundinnen und Kunden überhaupt davon wissen. Und genau das macht den Unterschied — weil du erklären, helfen und begeistern kannst.

So funktioniert's: Leere Migros-Verpackungen kommen in die neuen grünen Boxen an der Kasse. Sie werden dann direkt dem Recycling zugeführt — vollständig und nachvollziehbar.

Wir rechnen in der Pilotphase mit rund 40 Tonnen Plastik weniger im Abfall — pro Monat.

Das ist kein kleines Projekt. Das bist du.

Danke, dass du dabei bist.`
);

await ex('before-after', 'Migros – Produktbeschreibung von trocken zu lebendig',
  'Detailhandel / Produktkommunikation',
  `VORHER:
«Migros Bio Vollmilch, 3.5% Fett, 1 Liter, pasteurisiert. Herkunft: Schweiz. Ohne Zusatzstoffe. Kühl lagern.»

Was soll besser werden: Die Beschreibung soll Appetit machen, die Schweizer Herkunft und Bio-Qualität emotional verankern — aber ohne Marketingklischees. Kurz, direkt, im Migros-Du-Ton.`,
  `Frisch gemolken, nicht weit gereist.

Unsere Bio-Vollmilch kommt von Schweizer Kühen, die draussen grasen dürfen — und das schmeckt man. 3.5% Fett, pasteurisiert, ohne Zusatzstoffe. Einfach Milch, wie sie sein soll.

Kühl lagern, geniessen, nachkaufen. 1 Liter.`
);

await ex('vs-gen', 'Migros – 2 Varianten Kommunikation neue Eigenmarke (Sachlich vs. Emotional)',
  'Detailhandel / Markenkommunikation',
  `Wir lancieren eine neue Migros-Eigenmarke für pflanzenbasierte Produkte: «M-Planted». Schreibe zwei Varianten für die Lancierungskommunikation auf der Website (je ~80 Wörter).

Variante A: sachlich, produktorientiert — was ist M-Planted, warum gut
Variante B: emotional, werteorientiert — warum pflanzlich, was das für die Welt bedeutet

Beide im Migros-Du-Ton.`,
  `VARIANTE A — Sachlich & produktorientiert

M-Planted: Pflanzlich. Lecker. Echt Migros.

Unsere neue Eigenmarke bringt dir pflanzenbasierte Produkte, die schmecken — nicht weil sie müssen, sondern weil wir daran gearbeitet haben. Von der Tofuwurst bis zum Haferdrink: M-Planted hat das Beste aus der Pflanzenwelt in deinen Einkaufskorb gebracht.

Gleiche Migros-Qualität. Anderer Ursprung. Gleicher Preis wie die konventionelle Alternative.

Probier's aus — M-Planted findest du ab sofort in allen Filialen.

---

VARIANTE B — Emotional & werteorientiert

Gut essen. Gut fühlen. Gut für morgen.

Immer mehr Menschen wollen wissen, woher ihr Essen kommt — und was es mit der Welt macht. M-Planted ist unsere Antwort. Nicht als Ersatz, sondern als Erweiterung: pflanzliche Produkte, die du mit gutem Gewissen geniessen kannst.

Wir glauben, dass nachhaltig auch günstig, lecker und unkompliziert sein kann. Deswegen kostet M-Planted nicht mehr als das, was du schon kennst.

Deine Wahl. Dein Einfluss.`
);


// ════════════════════════════════════════════════════════════
// 2. ZURICH INSURANCE — seriös, präzise, vertrauenswürdig
// ════════════════════════════════════════════════════════════
console.log('\n── Zurich Insurance ──');
await bv(`ZURICH INSURANCE GROUP — Versicherung / Finanzdienstleistungen, global

KERNIDENTITÄT: «For those who truly love» — Versicherung als Ausdruck von Fürsorge
Sprachen: DE (CH), EN (International), bilingual in Corporate Comms

ANREDE: Sie-Form (Kundenkommunikation), Du möglich in jüngeren Kampagnen

SPRACHSTIL:
- Präzise, strukturiert, keine Doppeldeutigkeiten
- Kurze Hauptsätze, Schachtelsätze vermeiden
- Fachwörter erklären oder umgehen — Kundinnen sind keine Juristen
- Vertrauen durch Transparenz: «Was das für Sie bedeutet» immer mitdenken
- International: leicht britisches Englisch in Corporate Comms

THEMEN-GEWICHTUNG:
- Sicherheit und Schutz als emotionaler Kern
- Digitalisierung: einfach, schnell, unkompliziert
- Nachhaltigkeit: ESG-Reporting, grüne Produkte
- Kundenorientierung: Schäden schnell, fair, unkompliziert regeln

KUNDENKOMMUNIKATION:
- Versicherungsdeutsch aktiv vermeiden: «Im Schadensfall» → «Wenn etwas passiert»
- Aktiv statt Passiv: «Wir zahlen» nicht «Es wird reguliert»
- Abschlüsse positiv: «Wir sind für Sie da» statt «Bei Fragen wenden Sie sich an»

NICHT-ZURICH: Kein Angst-Marketing, keine juristischen Textbausteine ohne Erklärung`);

await ex('before-after', 'Zurich – Versicherungsdeutsch in Kundensprache übersetzen',
  'Versicherung / Kundenkommunikation',
  `VORHER (typisches Versicherungsdeutsch):
«Im Falle eines versicherten Schadenereignisses sind Sie verpflichtet, unverzüglich nach Kenntnisnahme des Schadens die Zurich Insurance Group AG schriftlich zu informieren. Die Geltendmachung von Ansprüchen hat innerhalb der vertraglich vereinbarten Fristen zu erfolgen. Wir behalten uns vor, Ansprüche bei verspäteter Meldung zu kürzen oder abzulehnen.»

Was soll besser werden: Gleiche rechtliche Kernaussage (Meldepflicht, Frist, Konsequenz), aber in verständliches, kundenfreundliches Deutsch übersetzen. Aktiv statt Passiv, kurze Sätze, keine Angst erzeugen — aber klar kommunizieren.`,
  `Wenn etwas passiert: Bitte melden Sie uns den Schaden so schnell wie möglich — am besten noch am selben Tag.

Das hilft uns, Ihnen rasch zu helfen. Und es sichert Ihre Ansprüche: Bei sehr später Meldung kann es passieren, dass wir den Schaden nicht mehr vollständig übernehmen können.

Sie erreichen uns jederzeit über die Zurich-App, telefonisch oder online unter zurich.ch/schaden.

Wir sind für Sie da.`
);

await ex('text-gen', 'Zurich – Kundenbrief Vertragsanpassung (Prämienerhöhung)',
  'Versicherung / Kundenkommunikation',
  `Schreibe einen Kundenbrief für eine Prämienerhöhung per 1. Januar. Erhöhung: ca. 8% aufgrund gestiegener Schadenkosten (Unwetter, Inflation im Baubereich).

Anforderungen: Ehrlich und klar — keine Beschönigung, aber auch keine Entschuldigung. Erklären warum, Verständnis zeigen, Handlungsoption geben (Angebot Review-Gespräch). Zurich-Tonalität: vertrauenswürdig, direkt, Sie-Form.`,
  `Ihre Haushaltsversicherung ab 1. Januar 2026

Sehr geehrte Frau Müller

Wir schätzen Ihre langjährige Treue als Kundin der Zurich. Deshalb möchten wir Sie rechtzeitig und offen über eine Anpassung Ihrer Prämie informieren.

Ab dem 1. Januar 2026 erhöht sich Ihre Jahresprämie um 8%, auf CHF [Betrag].

Warum? Die Häufigkeit und Schwere von Unwetterschäden hat in den letzten Jahren deutlich zugenommen — Überschwemmungen, Hagelstürme, Sturmschäden. Gleichzeitig sind die Kosten für Reparaturen und Wiederaufbau durch die Inflation spürbar gestiegen. Diese Entwicklung betrifft die gesamte Branche und macht eine Anpassung der Prämien notwendig.

Ihr Schutz bleibt vollständig erhalten. An Ihren Leistungen ändert sich nichts.

Möchten Sie Ihre Versicherungssituation besprechen oder prüfen, ob Ihr aktueller Schutz noch zu Ihrer Situation passt? Wir nehmen uns gerne Zeit für Sie.

Freundliche Grüsse
Zurich Insurance`
);

await ex('vs-gen', 'Zurich – 2 Varianten Kommunikation Cyberversicherung (B2C vs. B2B)',
  'Versicherung / Produktkommunikation',
  `Wir lancieren eine neue Cyberversicherung. Schreibe je einen Kurztext (~100 Wörter) für:

Variante A: B2C — Privatpersonen, die sich wenig mit Cyber beschäftigen. Thema: Phishing, Identitätsdiebstahl, einfach erklären.
Variante B: B2B — KMU-Inhaber, die Risiken kennen aber Budget scheuen. Thema: Ransomware, Betriebsunterbruch, ROI-Argumentation.

Beide in Zurich-Tonalität: klar, vertrauenswürdig, Sie-Form, kein Angst-Marketing.`,
  `VARIANTE A — B2C: Privatpersonen

Schützen Sie, was Ihnen wichtig ist — auch online.

Phishing-Mails, gefälschte Online-Shops, Identitätsdiebstahl: Cyberkriminalität trifft heute jeden. Mit der Zurich Cyber-Privatversicherung sind Sie geschützt — finanziell und mit persönlicher Unterstützung, wenn es darauf ankommt.

Was wir übernehmen: Schäden durch Datenmissbrauch, unberechtigte Abbuchungen, Wiederherstellung Ihrer digitalen Identität. Und wenn Sie nicht weiterkommen, ist unser Expertenteam 24h erreichbar.

Sicherheit im Netz — einfach, verständlich, Zurich.

---

VARIANTE B — B2B: KMU

Ihr Betrieb läuft. Was, wenn er plötzlich nicht mehr läuft?

Ein Ransomware-Angriff legt heute durchschnittlich 3–5 Arbeitstage lahm — mit Kosten von mehreren zehntausend Franken. Für viele KMU ist das existenzbedrohend.

Die Zurich Cyber-KMU-Versicherung deckt Betriebsunterbrüche, Wiederherstellungskosten und externe IT-Forensik ab. Dazu erhalten Sie Zugang zu unserem Cyber-Krisenteam, das sofort handelt — nicht erst nach der Schadensregulierung.

Prävention inklusive: Wir analysieren Ihre Schwachstellen, bevor etwas passiert.

Investition Sicherheit. Vor dem Schaden.`
);


// ════════════════════════════════════════════════════════════
// 3. DIGITEC GALAXUS — locker, humorvoll, ehrlich, modern
// ════════════════════════════════════════════════════════════
console.log('\n── Digitec Galaxus ──');
await bv(`DIGITEC GALAXUS — E-Commerce / Consumer Electronics, Schweiz

KERNIDENTITÄT: Grösster Online-Shop der Schweiz. Gegründet von Technikbegeisterten.
«Wir lieben Technik. Wir lieben Shopping. Wir lieben Dich.»

ANREDE: Du-Form — ausnahmslos. Auch in Fehlermeldungen und Rechnungen.

SPRACHSTIL:
- Locker, direkt, manchmal selbstironisch
- Humor erlaubt — aber nicht erzwungen. Wenn's nicht passt, lassen.
- Keine Marketingfloskeln: «einzigartig», «revolutionär», «unschlagbar» → verboten
- Fakten first: Specs ehrlich, auch wenn ein Produkt nicht für jeden passt
- Easter Eggs in Produktbeschreibungen willkommen (aber dezent)

PRODUKTBESCHREIBUNGEN:
- Zielgruppe kennt sich aus — nicht erklären was ein USB-C-Port ist
- Ehrlich über Schwächen: «Nicht ideal für...» gibt Vertrauen
- Vergleiche zu Vorgängermodell bei Upgrades
- Humor situativ: bei Alltagsprodukten ja, bei Sicherheitsprodukten nein

COMMUNITY & BLOG:
- Meinungsstark, auch kontrovers wenn nötig
- Transparenz: intern «hinter die Kulissen» zeigen
- Fehler zugeben — öffentlich und mit Haltung

NICHT-DIGITEC: Kein Corporate-Sprech, keine Passivkonstruktionen, kein «Sehr geehrte Damen und Herren»`);

await ex('text-gen', 'Digitec Galaxus – Produktbeschreibung mit ehrlichem Digitec-Ton',
  'E-Commerce / Produktkommunikation',
  `Schreibe eine Produktbeschreibung für einen True-Wireless-Kopfhörer im Digitec-Stil.

Produkt: Sony WF-1000XM5
Stärken: Beste Geräuschunterdrückung im Markt, hervorragender Klang, 8h Akku (+16h Ladecase)
Schwächen: Passform nicht für alle Ohren ideal, kein aptX, Premium-Preis
Zielgruppe: Technikaffine, die wissen was sie kaufen

Ton: direkt, ehrlich, leicht humorvoll — keine Superlative ohne Beleg, Schwächen offen ansprechen.`,
  `Sony WF-1000XM5 – Der Kopfhörer, der Meetings erträglicher macht.

Wer Noise Cancelling sagt, meint in der Regel den hier. Die WF-1000XM5 setzen nach wie vor den Massstab — egal ob Bürolärm, Zug oder weinendes Kind im Nebenabteil. Der Klang? Satt, ausgewogen, mit genug Detail auch für ernsthafte Hörsitzungen.

8 Stunden am Stück, dann nochmal 16 im Case. Reicht für fast jeden Arbeitstag — ausser du arbeitest bei einer Antarktisexpedition.

Ehrlich gesagt: Die Passform ist nicht für jedes Ohr gemacht. Probier sie aus, bevor du dein Abo für Siri-Witze kündigst. Und aptX gibt's hier nicht — für die meisten macht das keinen hörbaren Unterschied, für manche ist's ein Dealbreaker.

Premium-Preis. Premium-Ergebnis. Wer das Beste will, zahlt es auch.`
);

await ex('before-after', 'Digitec Galaxus – Langweiligen Tech-Text in Digitec-Tonalität übersetzen',
  'E-Commerce / Produktkommunikation',
  `VORHER (generischer Hersteller-Text):
«Das Samsung Galaxy S25 Ultra bietet eine fortschrittliche Quad-Kamera mit 200 MP Hauptsensor, einem leistungsstarken Snapdragon 8 Elite Prozessor sowie einem 5000-mAh-Akku für ganztägige Nutzung. Das hochauflösende 6,9-Zoll-Display mit 120-Hz-Bildwiederholrate sorgt für ein herausragendes Multimedia-Erlebnis.»

Was soll besser werden: Im Digitec-Stil umschreiben — ehrlich, direkt, mit Persönlichkeit. Stärken benennen, aber keine leeren Superlative. Zielgruppe kennt Specs.`,
  `200 Megapixel. Klingt viel — und ist es auch.

Das S25 Ultra macht Fotos, bei denen du hinterher reinzoomst, nur weil du kannst. Der Snapdragon 8 Elite macht dabei, was er soll: nichts bremsen, nichts ruckeln, nichts ins Schwitzen kommen.

6,9 Zoll mit 120 Hz: Ja, das Display ist gross. Nein, es passt nicht mehr in jede Hosentasche. Dafür läuft Netflix auf dem Ding wie im Kino — fast.

Akku: 5000 mAh. Mit moderater Nutzung kommst du durch den Tag. Mit intensivem Zocken und maximaler Helligkeit vielleicht nicht ganz. Ehrliche Ansage.

Für wen: Alle, die «das Beste» beim Smartphone meinen und bereit sind, es auch zu bezahlen.`
);

await ex('text-gen', 'Digitec Galaxus – Blog-Post zu einem kontroversen Tech-Thema',
  'E-Commerce / Content Marketing',
  `Schreibe einen kurzen Blog-Einstieg (120 Wörter) im Digitec-Stil zu folgendem Thema: «Braucht man wirklich ein neues Smartphone jedes Jahr?»

Ton: Meinungsstark, ehrlich, leicht provokativ — aber ohne zu moralisieren. Digitec verkauft Smartphones, sagt aber trotzdem die Wahrheit.`,
  `Kurze Antwort: Nein.

Längere Antwort: Es kommt drauf an — aber meistens immer noch nein.

Die Upgrades zwischen Smartphone-Generationen sind heute kleiner als früher. Bessere Kamera, 10% mehr Performance, ein neues Feature, das du in drei Wochen vergessen hast. Das reicht selten als Argument, wenn dein aktuelles Gerät noch tadellos funktioniert.

Trotzdem kaufen Millionen Menschen jedes Jahr ein neues Telefon. Wir verkaufen sie — logisch.

Aber wir finden, du solltest es aus dem richtigen Grund tun: weil dein altes kaputtgeht, weil ein konkretes Feature deinen Alltag verbessert, oder weil du es dir leisten kannst und willst.

«Weil neu» ist kein Grund. «Weil kaputt» schon.`
);


// ════════════════════════════════════════════════════════════
// 4. SBB — bürokratisch → vor/nachher Kandidat Nr. 1
// ════════════════════════════════════════════════════════════
console.log('\n── SBB ──');
await bv(`SBB CFF FFS — Öffentlicher Verkehr / Mobilität, Schweiz

KERNIDENTITÄT: «Die Bahn der Schweiz» — Grundversorgung, Pünktlichkeit, Verbindung
Dreisprachig: DE / FR / IT in offizieller Kommunikation

HERAUSFORDERUNG: Historisch bürokratisch-distanziert → aktive Transformation zu kundennah
Sprachreform «SBB Sprache» läuft seit Jahren, aber alte Muster hartnäckig

ANREDE: Sie-Form (Kundenkommunikation), aber zunehmend lockerer

ALTER STIL (zu vermeiden):
- Passivkonstruktionen: «Es wird darauf hingewiesen, dass...»
- Substantivierungen: «Die Durchführung der Überprüfung erfolgt...»
- Doppelungen: «zum gegenwärtigen Zeitpunkt» statt «jetzt»
- Distanz: «Reisende werden gebeten...»

NEUER STIL (Ziel):
- Direkte Ansprache: «Bitte beachten Sie...» oder «Wir bitten Sie...»
- Aktiv: «Wir prüfen» nicht «Es wird geprüft»
- Konkret: Zeitangaben, Gleisnummern, Alternativrouten klar benennen
- Empathie zeigen: «Wir entschuldigen uns für die Unannehmlichkeiten» — und es meinen

KUNDENKOMMUNIKATION:
- Störungsmeldungen: sofort, konkret, mit Alternative
- Entschuldigungen: ohne Floskeln, mit echtem Bedauern
- Preiskommunikation: transparent, ohne Kleingedrucktes zu verstecken`);

await ex('before-after', 'SBB – Bürokratischen Störungstext in kundenfreundliche Meldung',
  'Öffentlicher Verkehr / Kundenkommunikation',
  `VORHER (typischer SBB-Bürokratietext):
«Aufgrund von Gleisarbeiten im Bereich Olten–Zürich kommt es im Zeitraum vom 14.03. bis 16.03. zu Beeinträchtigungen im Fernverkehr. Reisende werden gebeten, erhöhte Reisezeiten einzuplanen und die aktuellen Fahrplaninformationen auf sbb.ch zu konsultieren. Eine Entschädigung gemäss den geltenden Fahrgastrechten wird geprüft.»

Was soll besser werden: Gleiche Information, aber klar, direkt, empathisch. Konkrete Alternativen nennen. Entschuldigung ehrlich formulieren, kein Juristendeutsch. Keine Passivkonstruktionen.`,
  `Baustelle Olten–Zürich: Ihr Zug braucht länger — wir erklären Ihnen warum und wie Sie trotzdem pünktlich ankommen.

Vom 14. bis 16. März arbeiten wir an den Gleisen zwischen Olten und Zürich. Das bedeutet: Züge auf dieser Strecke fahren mit Verspätungen von bis zu 30 Minuten.

Was bedeutet das für Sie?
– IC 1 und IR 17 fahren via Aarau — rechnen Sie 20 Minuten mehr ein
– S-Bahnen verkehren im normalen Takt
– Aktuelle Abfahrtszeiten direkt in der SBB App

Es tut uns leid für die Unannehmlichkeiten. Wenn Sie mehr als 60 Minuten zu spät ankommen, haben Sie Anrecht auf eine Entschädigung — einfach in der App oder am Schalter melden.

Wir arbeiten so schnell wie möglich.`
);

await ex('before-after', 'SBB – Formelles Entschuldigungsschreiben menschlicher formulieren',
  'Öffentlicher Verkehr / Kundenkommunikation',
  `VORHER:
«Sehr geehrte Damen und Herren, wir bestätigen den Eingang Ihrer Reklamation vom 3. März 2026. Die eingegangene Beanstandung wurde geprüft und es wurde festgestellt, dass aufgrund technischer Betriebsstörungen eine Verspätung von 47 Minuten eingetreten ist. Eine Erstattung in der Höhe von CHF 12.50 wird auf dem von Ihnen angegebenen Konto gutgeschrieben. Wir bedanken uns für Ihr Verständnis.»

Was soll besser werden: Gleicher Inhalt (Bestätigung, Betrag, Rückzahlung), aber menschlich und direkt. Echte Entschuldigung. Aktiv statt Passiv.`,
  `Betreff: Ihre Verspätung vom 3. März — wir erstatten Ihnen CHF 12.50

Guten Tag

Vielen Dank, dass Sie sich gemeldet haben — das hilft uns, besser zu werden.

Am 3. März hatte Ihr Zug 47 Minuten Verspätung wegen einer technischen Störung. Das ist ärgerlich, und wir entschuldigen uns aufrichtig dafür.

Wir erstatten Ihnen CHF 12.50 gemäss Fahrgastrechten. Der Betrag wird innert 5 Werktagen auf Ihr Konto überwiesen.

Falls Sie Fragen haben: Wir sind unter 0848 44 66 88 oder über sbb.ch für Sie da.

Freundliche Grüsse
SBB Kundenservice`
);

await ex('text-gen', 'SBB – Verspätungsansage im Zug (mündlich, empathisch)',
  'Öffentlicher Verkehr / Interne Kommunikation',
  `Schreibe eine Verspätungsansage für den Zugführer/die Zugführerin im Zug, der/die gerade eine unerwartete Verspätung von ca. 20 Minuten ankündigen muss (Grund: Signal-Störung vor Bern).

Tonalität: ehrlich, empathisch, klar. Kurz. Keine Floskeln. Anschlusszüge erwähnen. SBB-Stil neu (direkt, aktiv).`,
  `Guten Tag, hier spricht Ihre Zugführerin.

Wir haben leider eine schlechte Nachricht: Wegen einer Signalstörung vor Bern müssen wir warten. Wir rechnen mit etwa 20 Minuten Verspätung.

Was das für Sie bedeutet: Wir fahren weiter, sobald das Signal frei ist. Wenn Sie in Bern einen Anschluss haben, prüfen Sie bitte jetzt in der SBB App, ob er noch klappt — die meisten Anschlusszüge warten.

Es tut uns leid. Wir tun, was wir können, um Zeit aufzuholen.

Danke für Ihre Geduld.`
);


// ════════════════════════════════════════════════════════════
// 5. HELVETIA — warm, menschlich, regional, «einfach einfach»
// ════════════════════════════════════════════════════════════
console.log('\n── Helvetia ──');
await bv(`HELVETIA VERSICHERUNGEN — Versicherung / Vorsorge, Schweiz

KERNIDENTITÄT: «Einfach einfach» — Versicherung ohne Komplexität
Gegründet 1858 in St. Gallen, heute internationale Gruppe mit Schweizer Herzstück

ANREDE: Sie-Form (offiziell), zunehmend Du in digitalen Kanälen (unter 40 Jahre)

DIFFERENZIERUNG VS. ZURICH:
- Helvetia: wärmer, näher, regionaler — «Ihr Versicherungspartner»
- Zurich: globaler, professioneller, grösser
- Helvetia: Beziehung zu Kunden, nicht nur Produkt

SPRACHSTIL:
- Kurze Sätze, klare Struktur
- «Einfach einfach»: Fachbegriffe erklären, Versicherungssprache übersetzen
- Lokal verankert: Schweizer Bezug, regionale Beispiele
- Warm aber kompetent — kein Kitsch, kein Flirt
- Fortschritt betonen: digital, aber persönlich

KUNDENKOMMUNIKATION:
- Schadenfall: Mitgefühl first, Prozess second
- Vertragsänderungen: proaktiv informieren, Nutzen für Kunden erklären
- Beratung: «Wir schauen es gemeinsam an» — nicht bevormunden

KAMPAGNENBEISPIELE:
- «Was immer auch passiert — wir sind da.»
- «Einfach versichert. Einfach Helvetia.»
- Persönliche Geschichten aus dem Kundenleben

NICHT-HELVETIA: Kein Angst-Marketing, kein Kleingedrucktes als Argument, keine Distanz`);

await ex('text-gen', 'Helvetia – Kundenbrief neue Hausratversicherung, warm und klar',
  'Versicherung / Kundenkommunikation',
  `Schreibe einen Willkommensbrief für einen neuen Hausrat-Kunden der Helvetia. Versicherung startet am 1. April.

Was muss drin sein: Bestätigung des Versicherungsbeginns, kurze Erklärung was gedeckt ist (Einbruch, Feuer, Wasserschaden, Haushaltsgeräte), Hinweis auf App & Schadensnummer.

Tonalität: warm, menschlich, unkompliziert. Kein Versicherungsdeutsch. Sie-Form. Helvetia-Charakter: nahbar, kompetent, «einfach einfach».`,
  `Willkommen bei Helvetia — schön, dass Sie da sind.

Ihre neue Hausratversicherung startet am 1. April. Ab dann ist Ihr Zuhause bei uns gut aufgehoben.

Was wir für Sie übernehmen: Schäden durch Einbruch, Feuer, Wasserleitungsschäden und Naturgefahren — sowie Schäden an Ihren Haushaltsgeräten. Konkret: Wenn in Ihrer Abwesenheit eingebrochen wird, wenn die Waschmaschine ausläuft oder ein Sturm das Dach beschädigt, sind Sie bei uns versichert.

Wenn etwas passiert, sind wir sofort für Sie da — 24 Stunden, 365 Tage. Einfach anrufen: 058 280 10 00. Oder direkt in der Helvetia App melden — das geht meistens am schnellsten.

Ihre Unterlagen finden Sie im Anhang. Bei Fragen melden Sie sich gerne — wir schauen es gemeinsam an.

Herzliche Grüsse
Ihre Helvetia`
);

await ex('before-after', 'Helvetia – Kalt-formellen Brief in Helvetia-Tonalität übersetzen',
  'Versicherung / Kundenkommunikation',
  `VORHER (distanziert-formal):
«Sehr geehrter Herr Keller, wir teilen Ihnen mit, dass Ihre Motorfahrzeug-Haftpflichtversicherung per 1. Januar 2026 aufgrund der aktuellen Risikobewertung angepasst wird. Die neue Jahresprämie beträgt CHF 820.00 (bisher CHF 760.00). Bei Nichteinverständnis steht Ihnen das Recht zu, den Vertrag innerhalb von 30 Tagen zu kündigen. Für weitere Auskünfte steht Ihnen unser Kundendienst zur Verfügung.»

Was soll besser werden: Helvetia-Stil — gleiche Information, aber warm, klar, mit Erklärung warum. Kündigung erwähnen ohne es kalt zu formulieren. «Einfach einfach».`,
  `Ihre Autoversicherung ab Januar 2026

Guten Tag Herr Keller

Wir schreiben Ihnen, weil wir Ihre Prämie anpassen müssen — und das möchten wir Ihnen ehrlich erklären.

Ab dem 1. Januar 2026 beträgt Ihre Jahresprämie CHF 820 (bisher CHF 760). Das sind CHF 60 mehr im Jahr.

Warum? Die Schadenskosten im Fahrzeugbereich sind in den letzten zwei Jahren deutlich gestiegen — Ersatzteile, Werkstattpreise, Mietautos. Das schlägt sich leider auch bei den Prämien nieder.

Ihr Schutz bleibt identisch. Nichts an Ihrem Vertrag ändert sich ausser dem Preis.

Falls Sie die Prämie gerne besprechen möchten — wir schauen gerne gemeinsam, ob alles noch passt. Und wenn Sie kündigen möchten, können Sie das innerhalb von 30 Tagen tun — kein Drama, kein Aufwand.

Freundliche Grüsse
Ihre Helvetia`
);

await ex('vs-gen', 'Helvetia – 2 Varianten Schadensfall-Erstkommunikation (Empathisch vs. Prozessorientiert)',
  'Versicherung / Schadensfallkommunikation',
  `Ein Kunde meldet: Sein Auto wurde in der Nacht in Zürich aufgebrochen, Laptop und Koffer gestohlen. Schaden ca. CHF 3500.

Schreibe zwei Varianten der ersten Rückmeldung von Helvetia (E-Mail, nach Eingang der Schadensmeldung):

Variante A: Empathisch first — Mitgefühl, dann Prozess
Variante B: Prozess first — effizient, klar, mit Empathie am Ende

Beide im Helvetia-Stil (warm, klar, Sie-Form). Beide realistisch — keine leeren Versprechen über Schadenshöhe.`,
  `VARIANTE A — Empathisch first

Betreff: Ihr Schadenfall — wir kümmern uns darum.

Guten Tag

Das tut uns sehr leid — ein Einbruch ist nicht nur finanziell belastend, das ist auch ein Gefühl von Verletzung. Wir möchten, dass Sie so schnell wie möglich Klarheit haben.

Ihr Schadenfall ist bei uns eingegangen und wurde Frau Meier aus unserem Schadenteam zugeteilt. Sie meldet sich innerhalb von 24 Stunden bei Ihnen — mit konkreten nächsten Schritten und einer ersten Einschätzung.

Was Sie bis dahin tun können: Stellen Sie wenn möglich Fotos des Einbruchs und Belege für die gestohlenen Gegenstände zusammen. Das beschleunigt die Prüfung.

Wir sind für Sie da.
Ihre Helvetia

---

VARIANTE B — Prozess first

Betreff: Schadenfall [Nr.] — Ihre nächsten Schritte

Guten Tag

Ihre Schadensmeldung ist bei uns eingegangen. Wir haben Ihren Fall aufgenommen und bearbeiten ihn so rasch wie möglich.

Was jetzt passiert:
1. Wir prüfen Ihren Vertrag und den gemeldeten Schaden (2–3 Werktage)
2. Sie erhalten eine Rückmeldung mit der Schadenseinschätzung
3. Bei genehmigtem Schaden erfolgt die Zahlung innert 5 Werktagen

Was Sie uns noch senden können: Fotos des Einbruchs, Kaufbelege oder Fotos der gestohlenen Gegenstände — das beschleunigt die Prüfung.

Bei Fragen: 058 280 10 00 oder direkt per Antwort auf diese E-Mail.

Es tut uns leid, dass Ihnen das passiert ist.
Ihre Helvetia`
);

  console.log('\n✓ Alle Schweizer Unternehmens-Trainingsbeispiele deployed.');
  await pool.end();
}

main().catch(e => { console.error('FEHLER:', e.message); pool.end(); });
