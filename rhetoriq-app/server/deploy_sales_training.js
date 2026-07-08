const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://rhetoriq_db_user:qXv6yidawqN18C7HuE7pb7ajhygnkJHQ@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq_db',
  ssl: { rejectUnauthorized: false }
});
const ADVISOR_ID = 1;

async function ex(module, label, tag, input, output, rating = 5) {
  const r = await pool.query(
    `INSERT INTO module_examples
       (advisor_id, module_key, label, industry_tag, input_text, output_text,
        rating, source_client_id, is_cross_client_shareable, auto_generated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,true,false) RETURNING id`,
    [ADVISOR_ID, module, label, tag, input, output, rating]
  );
  console.log(`  ✓ #${r.rows[0].id} [${module}] ${label}`);
}

async function main() {

// ════════════════════════════════════════════════════════════
// B2B — ALLGEMEIN
// ════════════════════════════════════════════════════════════
console.log('\n── B2B Allgemein ──');

await ex('text-gen',
  'B2B – Executive Summary nach Discovery Call (Angebot)',
  'Verkauf / B2B / Dienstleistung',
  `Schreibe eine kurze Executive Summary für ein B2B-Angebot nach einem Discovery Call (1 Seite, ~200 Wörter).

Kontext:
- Dienstleister: Beratungsunternehmen für digitale Transformation
- Kunde: Schweizer KMU (Maschinenbau, 80 MA), hat Probleme mit manuellen Prozessen in Auftragsabwicklung
- Erkanntes Problem: 3 verschiedene Systeme, keine Schnittstellen, 2 FTE reine Datenpflege
- Lösung: ERP-Integration + Prozessautomatisierung, 6 Monate Projekt
- Investition: CHF 85'000

Tonalität: Selbstbewusst aber nicht aufdringlich. Problem des Kunden zuerst. ROI klar benennen. Keine technischen Details in der Summary.`,
  `Executive Summary — Digitale Auftragsabwicklung für [Kundenname]

Das Problem, das Sie beschrieben haben:
Drei Systeme, keine Schnittstellen, zwei Vollzeitstellen die täglich Daten übertragen. Jeder Auftrag durchläuft mindestens vier manuelle Schritte — das kostet Zeit, erzeugt Fehler und bremst Ihr Wachstum.

Was wir vorschlagen:
Eine integrierte ERP-Umgebung, die Ihre bestehenden Systeme verbindet und die manuelle Datenpflege vollständig eliminiert. Keine neue Software-Landschaft — wir bauen auf dem auf, was Sie haben.

Projektdauer: 6 Monate. Projektbeginn: nach Ihrer Freigabe.

Was Sie davon haben:
– 2 FTE für wertschöpfende Aufgaben freigesetzt (~CHF 160'000/Jahr)
– Fehlerquote in der Auftragsabwicklung auf nahezu null gesenkt
– Skalierbarkeit: Ihr System wächst mit Ihnen, ohne mehr Personal

Investition: CHF 85'000 einmalig.
ROI-Breakeven: 7 Monate nach Projektabschluss.

Wir haben diesen Weg mit 14 vergleichbaren KMU gegangen. Alle sind heute weiter als zuvor.

Nächster Schritt: 30-Minuten-Workshop zur Feinspezifikation — ohne Verpflichtung.`
);

await ex('before-after',
  'B2B – Schwaches Angebot zu überzeugendem Verkaufstext',
  'Verkauf / B2B / Angebotskommunikation',
  `VORHER (schwaches B2B-Angebot):
«Sehr geehrter Herr Brunner, wie besprochen unterbreiten wir Ihnen hiermit unser Angebot für die Implementierung unserer Softwarelösung. Unser Produkt bietet zahlreiche Funktionen und ist für viele Unternehmen geeignet. Der Preis beträgt CHF 24'000 pro Jahr. Bei Fragen stehen wir gerne zur Verfügung. Mit freundlichen Grüssen.»

Was fehlt: Kein Bezug zum Kundengespräch, kein erkanntes Problem, keine Nutzenargumentation, kein Handlungsaufruf, kein Vertrauen aufgebaut.

Was soll besser werden: Gleicher Preis, gleiche Lösung — aber als überzeugendes B2B-Angebot. Kundenproblem zuerst. Konkreter Nutzen. Klarer nächster Schritt.`,
  `Betreff: Ihr Angebot — Reportingautomatisierung für [Unternehmen]

Guten Tag Herr Brunner

In unserem Gespräch haben Sie beschrieben, wie Ihr Team jeden Monat 2–3 Tage damit verbringt, Reports manuell zusammenzustellen — aus vier verschiedenen Quellen, per Excel.

Genau das lösen wir.

Unsere Software zieht Ihre Daten automatisch aus allen Quellen, konsolidiert sie und liefert Ihnen jeden Monat bis Dienstag früh einen fertigen Report — ohne manuellen Aufwand.

Was das für Sie bedeutet:
– 24–36 Personentage pro Jahr zurückgewonnen
– Keine Fehler durch Copy-Paste
– Ihr Team kann sich auf Analyse konzentrieren, nicht auf Datenpflege

Investment: CHF 24'000/Jahr. Bei 30 Arbeitstagen, die Sie zurückgewinnen, entspricht das einem ROI von über 300% im ersten Jahr.

Was jetzt? Ich schlage einen 45-minütigen Demo-Termin vor — Sie sehen die Lösung live an Ihren eigenen Daten. Nächste Woche Dienstag oder Mittwoch?`
);

await ex('vs-gen',
  'B2B – 2 Varianten Follow-up E-Mail nach Sales-Meeting',
  'Verkauf / B2B / Follow-up',
  `Nach einem ersten Sales-Meeting mit einem potenziellen B2B-Kunden (CFO eines Industrieunternehmens, ~200 MA) schickst du ein Follow-up. Das Meeting lief gut, aber der CFO war noch zögerlich bezüglich Budget.

Schreibe zwei Varianten des Follow-up (je ~100 Wörter):

Variante A: Direktiv — fasst Nutzen zusammen, klarer Call to Action, nächsten Schritt vorschlagen
Variante B: Fragend — gibt dem Kunden Raum, fragt nach dem tatsächlichen Hindernis, hört zu statt zu pushen

Beide professionell, kein Druck, kein Sales-Sprech.`,
  `VARIANTE A — Direktiv

Betreff: Nächster Schritt — [Thema aus Meeting]

Guten Tag Frau Keller

Vielen Dank für das offene Gespräch gestern. Was ich mitgenommen habe: Ihr grösstes Problem ist nicht die Technologie — es ist die Zeit, die Ihr Team jeden Monat für manuelle Prozesse verliert.

Genau das adressieren wir. Und auf Basis Ihrer Angaben sehe ich einen ROI-Breakeven innerhalb von 8 Monaten.

Ich schlage vor, dass wir in einem 30-minütigen Deep-Dive die Zahlen gemeinsam durchgehen — damit Sie intern eine fundierte Entscheidung treffen können. Passt Ihnen nächste Woche Donnerstag, 10 Uhr?

---

VARIANTE B — Fragend & zuhörend

Betreff: Eine Frage nach unserem Gespräch

Guten Tag Frau Keller

Danke für Ihre Zeit gestern. Ich habe das Gespräch sehr geschätzt — Sie haben offen geredet, und das hilft mir mehr als eine Standard-Präsentation.

Ich würde gerne eine direkte Frage stellen: Was ist das eigentliche Hindernis? Ob Budget, Timing, interne Prioritäten oder etwas anderes — ich frage, weil ich nur dann wirklich helfen kann, wenn ich es verstehe.

Keine Verpflichtung, kein Verkaufsdruck. Nur ein ehrliches Gespräch über das, was für Sie realistisch ist.

Was meinen Sie?`
);


// ════════════════════════════════════════════════════════════
// B2C — ALLGEMEIN
// ════════════════════════════════════════════════════════════
console.log('\n── B2C Allgemein ──');

await ex('text-gen',
  'B2C – Upsell-E-Mail bestehender Kunde, neues Premium-Angebot',
  'Verkauf / B2C / E-Mail-Marketing',
  `Schreibe eine kurze Upsell-E-Mail (150 Wörter) für bestehende Kunden eines Online-Fitnessanbieters. Diese Kunden haben das Basis-Abo (CHF 19/Monat) und werden auf das Premium-Abo (CHF 39/Monat) hingewiesen.

Was ist neu im Premium: Personalisierter Trainingsplan, wöchentliches 20-Min-Check-in mit Coach per Video, Ernährungsguide.

Tonalität: Persönlich, nicht aufdringlich. Zeigen was der Kunde gewinnt, nicht was er verpasst. Klarer CTA. Kein Druck.`,
  `Betreff: Für dich, weil du dabei bist — ein kurzer Hinweis

Hey [Vorname]

Du trainierst jetzt seit [X Monaten] mit uns. Das freut uns wirklich.

Wir wollten dir kurz zeigen, was wir für unsere engagiertesten Mitglieder aufgebaut haben — das Premium-Abo.

Was dazukommt:
– Trainingsplan, der wirklich auf dich passt (nicht generisch)
– Wöchentliches 20-Min-Check-in mit deinem Coach per Video
– Ernährungsguide mit konkreten Plänen, nicht nur Tipps

Kein Plan von der Stange. Jemand, der mitdenkt.

CHF 39/Monat statt 19. Du kannst jederzeit zurückwechseln.

Wenn du neugierig bist: Einfach antworten, und wir stellen dir deinen Coach vor — bevor du dich entscheidest.

Bleib dran.
[Name], dein Team`
);

await ex('before-after',
  'B2C – Produktseite von beschreibend zu kaufauslösend',
  'Verkauf / B2C / Website / E-Commerce',
  `VORHER (beschreibender Produkttext, kein Kaufimpuls):
«Unsere Schreibtischlampe LED Pro ist mit einem flexiblen Arm ausgestattet und bietet 5 Helligkeitsstufen sowie 3 Farbtemperaturen. Sie hat einen USB-Ladeanschluss und einen Berührungssensor. Das Gerät ist in Schwarz und Weiss erhältlich und hat einen Energieverbrauch von 12 Watt.»

Was soll besser werden: Gleiche Fakten, aber auf den Kundennutzen ausgerichtet. Wer kauft das und warum? Was ändert sich in seinem Alltag? CTA am Ende.`,
  `Schluss mit Kopfschmerzen nach langen Abenden.

Die LED Pro passt sich deinen Augen an — nicht umgekehrt. Ob du um 22 Uhr noch arbeitest oder morgens um 7 Uhr den Tag startest: 5 Helligkeitsstufen und 3 Farbtemperaturen bedeuten, dass du immer genau das richtige Licht hast. Kalt für Konzentration. Warm zum Runterkommen.

Der flexible Arm bringt das Licht genau dorthin, wo du es brauchst. Der USB-Port lädt dein Handy, während du arbeitest.

12 Watt. Kaum spürbar auf der Rechnung.

Erhältlich in Schwarz und Weiss.

Jetzt bestellen — Lieferung in 2–3 Werktagen.`
);


// ════════════════════════════════════════════════════════════
// HOTEL SUITE — spezifisch
// ════════════════════════════════════════════════════════════
console.log('\n── Hotel Suite ──');

await ex('text-gen',
  'Hotel Suite – Pre-Arrival Upgrade-Angebot (persönlich, nicht aufdringlich)',
  'Hotellerie / Verkauf / Upselling',
  `Schreibe ein Pre-Arrival Upgrade-Angebot (E-Mail, ~150 Wörter) für einen Hotel-Gast, der eine Standarddoppelzimmer gebucht hat. Das Hotel hat eine Suite frei (Alpenblick-Suite, CHF 180 Aufpreis, 2 Nächte = CHF 360 total).

Was die Suite bietet: 55m², separate Wohnecke, freistehende Badewanne mit Bergblick, Champagner bei Ankunft inklusive.

Tonalität: Persönlich, exklusiv, einladend — kein Spam-Gefühl, kein Druck. Gast soll das Gefühl haben, er wurde persönlich ausgewählt, nicht alle erhalten dieses Angebot. Einfacher CTA.`,
  `Betreff: Ein besonderes Angebot vor Ihrer Ankunft

Guten Tag [Vorname Nachname]

Wir freuen uns sehr auf Ihren Aufenthalt bei uns vom [Datum].

Da wir Ihnen etwas Besonderes anbieten möchten: Unsere Alpenblick-Suite ist für Ihre Tage noch verfügbar — und wir würden sie gerne Ihnen reservieren.

55 Quadratmeter mit separater Wohnecke, einer freistehenden Badewanne mit direktem Blick auf die Berge — und ein Glas Champagner wartet bei Ihrer Ankunft auf Sie.

Upgrade-Preis für Ihren Aufenthalt: CHF 360 total (CHF 180 pro Nacht).

Falls Sie Interesse haben, antworten Sie einfach auf diese E-Mail oder klicken Sie hier: [Link]. Wir reservieren die Suite direkt für Sie.

Wir freuen uns, Sie bald begrüssen zu dürfen.

Herzliche Grüsse
[Name], Guest Relations`
);

await ex('vs-gen',
  'Hotel Suite – 2 Varianten Special Occasion Package (Romantisch vs. Exklusiv-Premium)',
  'Hotellerie / Verkauf / Paketangebote',
  `Wir verkaufen ein «Special Occasion Package» für unsere Panorama-Suite (4-Sterne-Resort, Alpen). Paket beinhaltet: 2 Nächte Suite, privates 3-Gang-Dinner auf der Terrasse, Spa-Zugang, Late Checkout.

Schreibe zwei Verkaufstexte für die Website (~120 Wörter je):

Variante A: Romantisch — für Paare, Jahrestag, Geburtstag. Emotional, intim, Bildsprache.
Variante B: Exklusiv-Premium — für Kunden die Luxus und Diskretion suchen. Weniger emotional, mehr «das Beste, was wir haben». Ruhigere Tonalität.`,
  `VARIANTE A — Romantisch

Manche Momente verdienen mehr als ein gutes Hotel.

Das Special Occasion Package ist für die Abende, die man nicht vergisst: ein privates 3-Gang-Dinner auf Ihrer Terrasse, während die Sonne hinter dem Alpstein versinkt. Keine anderen Gäste. Nur ihr.

Zwei Nächte in unserer Panorama-Suite — 62 Quadratmeter, freistehende Badewanne, Bergblick aus jedem Fenster. Dazu Spa-Zugang und ein Late Checkout, damit der letzte Morgen nicht zu früh endet.

Für Jahrestage. Geburtstage. Oder einfach weil es Zeit war.

Ab CHF 890 für zwei Personen — inkl. allem.

---

VARIANTE B — Exklusiv-Premium

Unser bestes Angebot. Für Gäste, die das Beste schätzen.

Das Special Occasion Package kombiniert unsere Panorama-Suite mit einem exklusiv geführten Dinner auf Ihrer privaten Terrasse — gestaltet von Küchenchef [Name], 16 Gault-Millau-Punkte.

Leistungen: 2 Nächte Panorama-Suite (62m², Alpenpanorama), privates 3-Gang-Dinner mit Weinbegleitung, vollständiger Spa-Zugang, Late Checkout 14:00 Uhr, persönlicher Concierge für die gesamte Aufenthaltsdauer.

Diskret. Hochwertig. Ohne Kompromisse.

Paketpreis: CHF 890 für zwei Personen. Auf Anfrage auch als Arrangement mit Transfer oder weiteren Leistungen buchbar.`
);


// ════════════════════════════════════════════════════════════
// CAPITAL / INVESTMENT — spezifisch
// ════════════════════════════════════════════════════════════
console.log('\n── Capital / Investment ──');

await ex('text-gen',
  'Capital – Investor Outreach E-Mail (Erstkontakt, Cold)',
  'Finanzen / Venture Capital / Fundraising',
  `Schreibe eine Cold-Outreach-E-Mail (120 Wörter) für einen Startup-Gründer, der einen VC-Investor zum ersten Mal kontaktiert.

Unternehmen: Schweizer Deep-Tech-Startup, AI-gestützte Qualitätskontrolle für die Fertigungsindustrie
Traction: 3 zahlende Kunden (Siemens, ein Schweizer KMU, ein deutsches Automobilzulieferer), CHF 280k ARR, Wachstum 40% QoQ
Runde: CHF 3M Seed
Investor-Profil: Fokus Deep Tech und Industry 4.0, hat bereits 3 ähnliche Companies gebackt

Tonalität: Selbstbewusst, respektvoll, direkt. Kein Betteln. Investor soll das Gefühl haben, er verpasst etwas Interessantes — nicht, dass er gebraucht wird.`,
  `Betreff: AI-Qualitätskontrolle Fertigung — CHF 280k ARR, 40% QoQ

Guten Tag [Name]

Ich schreibe Ihnen, weil Ihr Portfolio zeigt, dass Sie Industry 4.0 und Deep Tech nicht als Buzzwords behandeln — sondern als ernsthafte Kategorie.

Wir bauen KI-gestützte Qualitätskontrolle für die Fertigungsindustrie. Unsere Software erkennt Produktionsfehler in Echtzeit — 15x schneller als menschliche Inspektion, 3x günstiger als bisherige Systeme.

Heute: CHF 280k ARR, 3 zahlende Kunden — darunter Siemens. Wachstum 40% Quarter-over-Quarter seit 12 Monaten.

Wir schliessen eine CHF 3M Seed-Runde. Zwei Slots sind noch offen.

Hätten Sie 20 Minuten in den nächsten zwei Wochen? Ich schicke Ihnen gerne vorab das Deck.

[Name], CEO [Startup]`
);

await ex('before-after',
  'Capital – LP-Update von trocken zu überzeugend',
  'Finanzen / Private Equity / Investor Relations',
  `VORHER (trockener LP-Update eines Fonds):
«Sehr geehrte Investoren, hiermit übermitteln wir Ihnen das Quartals-Update Q3 2025. Das Portfolio umfasst aktuell 12 Unternehmen. Drei Unternehmen haben ihre Umsatzziele erreicht, zwei liegen unter Plan. Die Bewertung des Portfolios beträgt CHF 48 Millionen (Vorquartal: CHF 44 Millionen). Wir werden Sie über weitere Entwicklungen informieren.»

Was soll besser werden: Gleiche Zahlen, aber als Investoren-Brief der Vertrauen aufbaut. Was bedeuten die Zahlen? Wo liegt die Strategie? Was läuft gut, was nicht — und warum? Ein LP soll nach dem Lesen das Gefühl haben: «Die wissen was sie tun.»`,
  `Q3 2025 — Portfolio Update

Liebe Investorinnen und Investoren

Ein starkes Quartal — mit einem ehrlichen Blick auf das, was noch nicht stimmt.

Das Portfolio: CHF 48 Millionen (+ 9% vs. Q2). 12 Unternehmen, davon 3 ahead of plan, 2 below.

Was gut läuft:
[Company A] hat seinen ersten Enterprise-Kunden gewonnen — ein Vertrag, der unsere ursprüngliche ARR-Prognose für 2025 um 30% übertrifft. Das war kein Glück, das war 18 Monate Arbeit.

Was wir genau beobachten:
[Company B] ist 15% unter seinem Umsatzziel. Der Grund ist klar — ein Schlüsselkunde hat den Roll-out verschoben, nicht abgesagt. Wir haben den Gründer begleitet, den Vertrag neu strukturiert. Auslieferung Q1 2026.

Unsere Einschätzung: Das Portfolio ist gesünder als die Zahlen suggerieren. Zwei Unternehmen stehen kurz vor Runden, über die wir Sie im Q4-Update informieren werden.

Fragen? Wir sprechen gerne.
[GP Name], Managing Partner`
);

await ex('vs-gen',
  'Capital – 2 Varianten Pitch-Einstieg (Problem-Driven vs. Vision-Driven)',
  'Finanzen / Startup / Pitch',
  `Schreibe zwei Einstiegsvarianten für einen Investor-Pitch (je 60–80 Wörter, mündlich gehalten):

Unternehmen: ClimateTech-Startup, das CO2-Zertifikate via Blockchain verifiziert und handelbar macht. Problem: 40% der heutigen CO2-Zertifikate sind unzuverlässig oder doppelt verbucht.

Variante A: Problem-Driven — startet mit dem Problem, das der Markt hat
Variante B: Vision-Driven — startet mit dem Bild der Welt, die man bauen will

Beide prägnant, ohne Jargon, überzeugend.`,
  `VARIANTE A — Problem-Driven

40 Prozent der heute gehandelten CO2-Zertifikate sind entweder unzuverlässig, nicht überprüfbar oder doppelt verbucht. Unternehmen kaufen Klimaschutz — und bekommen oft nichts dafür.

Das ist nicht nur ein Reputationsproblem. Es ist ein Marktversagen in einem Bereich, der für die Klimawende entscheidend ist.

Wir machen CO2-Zertifikate verifizierbar, transparent und handelbar — in Echtzeit, via Blockchain. Keine Blackboxen mehr.

---

VARIANTE B — Vision-Driven

Stellen Sie sich einen Markt vor, in dem jeder Franken, der in CO2-Kompensation fliesst, nachweislich ankommt. In dem Unternehmen wissen, was sie wirklich kaufen. Und in dem Vertrauen kein Luxus ist, sondern Standard.

Das ist der Markt, den wir bauen.

Mit Blockchain-Verifikation von CO2-Zertifikaten machen wir Klimaschutz messbar — und damit erst wirklich wirksam.`
);

  console.log('\n✓ Alle Sales-Trainingsbeispiele deployed.');
  await pool.end();
}

main().catch(e => { console.error('FEHLER:', e.message); pool.end(); });
