// Bibliothek von Seitentypen für Gastronomie-Webseiten.
// Grundlage für den Batch-Generator: pro Seitentyp Ziel, Aufbau, Länge, Einstieg, Call-to-Action,
// Suchbegriffe, FAQ-Fragen, Pflichtfakten und URL-Muster. Dazu promptFuer() und parseAusgabe().
// Die Texte dieser Datei erzeugen Nutzertexte: Schweizer Schreibweise, keine Gedankenstriche.

const FAKTEN_KEYS = ['strasse', 'plz', 'ort', 'telefon', 'oeffnungszeiten', 'kueche', 'reservation_url',
  'kapazitaet_innen', 'kapazitaet_terrasse', 'anlaesse', 'kuechenchef', 'gruendungsjahr', 'besonderheiten', 'auszeichnungen'];

// Kurzschreibweise: Abschnitte als [h2, inhalt]
function typ(key, label, gruppe, ziel, aufbau, laengeWoerter, einstieg, cta, suchbegriffe, faqFragen, pflichtFakten, pfadMuster) {
  return {
    key, label, gruppe, ziel,
    aufbau: aufbau.map(([h2, inhalt]) => ({ h2, inhalt })),
    laengeWoerter, einstieg, cta, suchbegriffe, faqFragen, pflichtFakten, pfadMuster,
  };
}

const ADR = ['strasse', 'plz', 'ort', 'telefon'];

const LISTE = [
  typ('startseite', 'Startseite', 'Kern',
    'Die Leserin versteht in fünf Sekunden, was das Restaurant ausmacht, und reserviert oder liest weiter.',
    [['Was Sie bei uns erwartet', 'Kern des Hauses in drei bis vier Sätzen: Küche, Ort, Stimmung'],
     ['Essen und Trinken', 'Küche und Signatur, ohne Speisekarte abzuschreiben'],
     ['Für jeden Anlass', 'Verweis auf Mittag, Anlässe und Events'],
     ['So finden Sie uns', 'Lage, Zugang, Reservation']],
    [180, 320],
    'Eine Szene aus Gästesicht: der erste Moment beim Eintreten, ein Geruch, ein Licht, ein Geräusch am Tisch.',
    'Tisch reservieren',
    ['{ort} Restaurant {kueche}', 'Restaurant {ort}', '{restaurantName} {ort}'],
    ['Wo befindet sich das Restaurant?', 'Wann hat das Restaurant geöffnet?', 'Wie reserviere ich einen Tisch?'],
    [...ADR, 'oeffnungszeiten', 'kueche', 'reservation_url'],
    ['^/?$', '^/(index|home|startseite)$']),
  typ('ueber_uns', 'Über uns', 'Kern',
    'Die Leserin lernt die Menschen und die Haltung hinter dem Restaurant kennen und fasst Vertrauen.',
    [['Wer wir sind', 'Menschen, Haltung, was ihnen beim Gastgeben wichtig ist'],
     ['Unsere Küche', 'Handwerk, Produkte, Herkunft, nur belegbare Angaben'],
     ['Unser Team', 'Küche und Service, Namen nur aus den Fakten']],
    [250, 450],
    'Eine Szene aus dem Alltag des Hauses, etwa der Morgen in der Küche, gesehen mit den Augen eines Gastes.',
    'Besuchen Sie uns',
    ['{restaurantName} Team', 'Restaurant {ort} Geschichte und Team'],
    ['Wer kocht im Restaurant?', 'Seit wann gibt es das Restaurant?', 'Woher stammen die Produkte?'],
    ['kuechenchef', 'gruendungsjahr', 'kueche', 'besonderheiten'],
    ['(^|/)(ueber-uns|uber-uns|about|about-us|das-team|philosophie|wir-ueber-uns|unser-haus)(/|$)']),
  typ('geschichte', 'Geschichte', 'Kern',
    'Die Leserin versteht, woher das Haus kommt, und spürt die Tradition als Grund für den Besuch.',
    [['Die Anfänge', 'Gründung und Ort, nur belegte Daten'],
     ['Meilensteine', 'Wichtige Stationen in ruhiger Chronologie'],
     ['Heute', 'Was von der Geschichte im Alltag spürbar ist']],
    [250, 500],
    'Ein Bild aus der Vergangenheit, das in der Gegenwart noch zu sehen oder zu schmecken ist.',
    'Erleben Sie es selbst',
    ['{restaurantName} Geschichte', '{ort} Restaurant Tradition'],
    ['Seit wann besteht das Restaurant?', 'Gibt es Führungen oder Besichtigungen?'],
    ['gruendungsjahr', 'besonderheiten', 'auszeichnungen'],
    ['(^|/)(geschichte|history|chronik|tradition)(/|$)']),
  typ('speisekarte_intro', 'Speisekarte (Einleitung)', 'Kulinarik',
    'Die Leserin bekommt Lust auf die Karte und weiss, was sie dort erwartet.',
    [['Unsere Küche', 'Ausrichtung und Handschrift in wenigen Sätzen'],
     ['Saisonal und regional', 'Herkunft und Wechsel der Karte, nur belegbar'],
     ['Besondere Wünsche', 'Allergien, vegetarisch, vegan, Verweis auf Rückfrage']],
    [120, 250],
    'Ein Gericht, das auf den Tisch kommt: Duft, Farbe, erster Bissen.',
    'Karte ansehen und Tisch reservieren',
    ['{ort} Speisekarte {kueche}', '{restaurantName} Menü'],
    ['Gibt es vegetarische oder vegane Gerichte?', 'Wie gehen Sie mit Allergien um?', 'Wie oft wechselt die Karte?'],
    ['kueche', 'kuechenchef', 'besonderheiten', 'reservation_url'],
    ['(^|/)(speisekarte|speisekarten|karte|menu|menue|menues|menus|essen|kulinarik|food|carte)(/|$)']),
  typ('mittag', 'Mittag', 'Kulinarik',
    'Die Leserin sieht, dass der Mittag hier schnell, gut und planbar ist, und kommt in der Mittagspause vorbei.',
    [['Mittagessen in {ort}', 'Angebot, Zeiten, Tagesmenü, Preisrahmen nur aus den Fakten'],
     ['So schnell sind Sie am Tisch', 'Ablauf für Berufstätige, Reservation für Gruppen'],
     ['Für Teams und Kunden', 'Mittagessen mit Kollegen oder Gästen']],
    [150, 300],
    'Ein Mittag aus Gästesicht: die kurze Pause, der freie Tisch am Fenster, das Essen, das rechtzeitig kommt.',
    'Tisch für den Mittag reservieren',
    ['{ort} Mittagessen', '{ort} Lunch Restaurant', 'Businesslunch {ort}'],
    ['Wie viel kostet das Mittagsmenü?', 'Bis wann kann ich mittags bestellen?', 'Kann ich mittags reservieren?'],
    ['oeffnungszeiten', 'kueche', 'reservation_url', 'telefon'],
    ['(^|/)(mittag|mittagessen|mittagsmenu|mittagsmenue|mittagstisch|lunch|businesslunch|business-lunch|tagesmenu)(/|$)']),
  typ('brunch', 'Brunch', 'Kulinarik',
    'Die Leserin stellt sich den Brunch als gemeinsamen, entspannten Vormittag vor und reserviert.',
    [['Brunch in {ort}', 'Was auf den Tisch kommt, Zeiten, Preis nur aus den Fakten'],
     ['Ablauf', 'Buffet oder à la carte, Dauer, Getränke'],
     ['Für Familien und Gruppen', 'Kinder, Geburtstage, Reservation']],
    [150, 300],
    'Ein später Vormittag: Kaffeeduft, warmes Gebäck, lange Gespräche am Tisch.',
    'Brunch reservieren',
    ['Brunch {ort}', '{ort} Sonntagsbrunch'],
    ['Wann findet der Brunch statt?', 'Was kostet der Brunch?', 'Gibt es Angebote für Kinder?'],
    ['oeffnungszeiten', 'reservation_url', 'telefon', 'besonderheiten'],
    ['(^|/)(brunch|sonntagsbrunch|fruehstueck|fruhstuck|breakfast)(/|$)']),
  typ('nachmittag_tea', 'Nachmittag und Tea', 'Kulinarik',
    'Die Leserin sieht den Nachmittag als kleine Auszeit und plant einen Besuch zu zweit oder mit Freundinnen.',
    [['Der Nachmittag bei uns', 'Angebot, Zeiten, Atmosphäre'],
     ['Tee, Kaffee und Gebäck', 'Auswahl, nur belegbare Angaben'],
     ['Für besondere Nachmittage', 'Geburtstage, Treffen, Reservation']],
    [120, 250],
    'Eine Auszeit am Nachmittag: das Klirren einer Tasse, Licht im Raum, Zeit zum Reden.',
    'Nachmittag reservieren',
    ['Afternoon Tea {ort}', 'Kaffee und Kuchen {ort}', 'Tea Time {ort}'],
    ['Wann gibt es den Nachmittagstee?', 'Muss ich dafür reservieren?'],
    ['oeffnungszeiten', 'reservation_url', 'telefon'],
    ['(^|/)(tea|afternoon-tea|teatime|tea-time|nachmittag|kaffee-und-kuchen|patisserie|konditorei)(/|$)']),
  typ('bar_wein', 'Bar und Wein', 'Kulinarik',
    'Die Leserin sieht die Bar oder den Weinkeller als eigenen Grund für den Abend.',
    [['Die Bar', 'Charakter, Drinks, Atmosphäre, Öffnungszeiten'],
     ['Wein', 'Auswahl, Herkunft, Empfehlung, nur belegbare Angaben'],
     ['Für den Abend', 'Apéro, Degustation, Reservation']],
    [150, 320],
    'Ein Abend an der Bar: gedämpftes Licht, ein Glas in der Hand, Stimmen im Hintergrund.',
    'Tisch oder Platz an der Bar reservieren',
    ['Bar {ort}', 'Weinbar {ort}', 'Apéro {ort}', 'Cocktails {ort}'],
    ['Wann hat die Bar geöffnet?', 'Gibt es Weindegustationen?', 'Kann ich in der Bar reservieren?'],
    ['oeffnungszeiten', 'telefon', 'besonderheiten', 'reservation_url'],
    ['(^|/)([a-z0-9-]*bar|weinbar|bar-und-wein|wein|weine|weinkarte|weinkeller|cocktails|apero|aperitif|lounge)(/|$)']),
  typ('bankette', 'Bankette', 'Anlässe',
    'Die Anfragerin sieht, dass das Haus grössere Feiern sicher und persönlich ausrichtet, und fragt an.',
    [['Bankette in {ort}', 'Anlässe, Platzzahl, Räume nur aus den Fakten'],
     ['Räume und Platz', 'Räume mit Kapazität, Stühlung, Technik'],
     ['Menü und Getränke', 'Menüvorschläge, Pauschalen nur belegt'],
     ['So läuft die Planung ab', 'Anfrage, Beratung, Offerte']],
    [250, 450],
    'Der Moment, in dem die Gäste den festlich gedeckten Raum betreten und das Licht auf den Tischen sehen.',
    'Unverbindlich anfragen',
    ['Bankett {ort}', 'Festsaal {ort}', 'Feier {ort} Restaurant'],
    ['Für wie viele Personen sind Bankette möglich?', 'Wie weit im Voraus muss ich anfragen?', 'Kann das Menü individuell angepasst werden?'],
    ['kapazitaet_innen', 'anlaesse', 'telefon', 'besonderheiten'],
    ['(^|/)(bankett|bankette|banketts|gesellschaften|festsaal|feiern|feste|saal|saele|raeume|raumvermietung|events-und-bankette)(/|$)']),
  typ('firmenanlass', 'Firmenanlass', 'Anlässe',
    'Die Verantwortliche für den Anlass sieht, dass hier Firmenessen, Apéros und Jubiläen reibungslos ablaufen, und fragt an.',
    [['Firmenanlässe in {ort}', 'Anlassarten und Gruppengrössen aus den Fakten'],
     ['Was wir für Ihr Team organisieren', 'Apéro, Menü, Technik, Ablauf'],
     ['So läuft die Planung ab', 'Anfrage, Beratung, Offerte']],
    [220, 400],
    'Ein Teamessen aus der Sicht der Organisatorin: alles ist bereit, das Team lacht, sie kann selbst geniessen.',
    'Firmenanlass anfragen',
    ['Firmenanlass {ort}', 'Firmenessen {ort}', 'Weihnachtsessen Firma {ort}', 'Teamevent {ort}'],
    ['Für wie viele Personen eignet sich das Restaurant?', 'Gibt es Pauschalen für Firmen?', 'Ist Technik für Präsentationen vorhanden?'],
    ['kapazitaet_innen', 'anlaesse', 'telefon', 'besonderheiten'],
    ['(^|/)(firmenanlass|firmenanlaesse|firmenevent|firmenevents|firmenfeier|firmenfeiern|firmenessen|firmen|business|corporate|geschaeftsessen|teamevent|teamanlass)(/|$)']),
  typ('privatanlass', 'Privatanlass', 'Anlässe',
    'Die Leserin sieht, dass Geburtstage, Taufen und Familienfeiern hier persönlich und entspannt gefeiert werden.',
    [['Private Feiern in {ort}', 'Anlässe und Gruppengrössen aus den Fakten'],
     ['Was wir für Ihre Feier tun', 'Menü, Raum, Dekoration, Ablauf'],
     ['So läuft die Planung ab', 'Anfrage, Beratung, Offerte']],
    [200, 380],
    'Ein Familienfest: die Grossmutter am Kopfende, die Kinder unter dem Tisch, das Dessert im Kerzenlicht.',
    'Feier anfragen',
    ['Geburtstagsfeier {ort}', 'Familienfeier {ort}', 'Taufe Restaurant {ort}'],
    ['Wie viele Personen können wir einladen?', 'Dürfen wir eine Torte mitbringen?', 'Gibt es Kinderteller?'],
    ['kapazitaet_innen', 'anlaesse', 'telefon', 'besonderheiten'],
    ['(^|/)(privatanlass|privatanlaesse|privatevent|privatfeier|privatfeiern|private-anlaesse|private-feiern|familienfeier|geburtstag|geburtstagsfeier|taufe)(/|$)']),
  typ('hochzeit', 'Hochzeit', 'Anlässe',
    'Das Brautpaar spürt, dass sein Tag hier gut aufgehoben ist, und vereinbart ein Gespräch.',
    [['Heiraten in {ort}', 'Rahmen, Platzzahl, Ort aus den Fakten'],
     ['Ihr Tag bei uns', 'Ablauf von Apéro bis Dessert, Räume, Terrasse'],
     ['Menü und Getränke', 'Vorschläge, nur belegbare Angaben'],
     ['So planen wir gemeinsam', 'Besichtigung, Beratung, Offerte']],
    [250, 450],
    'Der Moment kurz vor dem Apéro: das Paar tritt aus der Tür, die Gäste drehen sich um, Gläser klingen.',
    'Besichtigungstermin vereinbaren',
    ['Hochzeit {ort}', 'Hochzeitslocation {ort}', 'Hochzeitsfeier Restaurant {ort}'],
    ['Wie viele Gäste finden Platz?', 'Ist eine Besichtigung möglich?', 'Gibt es Übernachtungsmöglichkeiten in der Nähe?'],
    ['kapazitaet_innen', 'kapazitaet_terrasse', 'anlaesse', 'telefon'],
    ['(^|/)(hochzeit|hochzeiten|heiraten|hochzeitsfeier|trauung|wedding|weddings)(/|$)']),
  typ('meetings', 'Meetings und Seminare', 'Anlässe',
    'Die Planerin sieht, dass Seminare und Sitzungen hier konzentriert und gut verpflegt stattfinden.',
    [['Seminare und Meetings in {ort}', 'Räume, Kapazität, Technik aus den Fakten'],
     ['Ausstattung und Verpflegung', 'Technik, Pausen, Mittagessen'],
     ['So läuft die Reservation ab', 'Anfrage, Beratung, Offerte']],
    [200, 380],
    'Eine Sitzung aus Sicht der Teilnehmenden: heller Raum, funktionierende Technik, Kaffee zur rechten Zeit.',
    'Seminarraum anfragen',
    ['Seminarraum {ort}', 'Meetingraum {ort}', 'Tagung {ort}'],
    ['Welche Technik ist vorhanden?', 'Für wie viele Personen sind die Räume geeignet?', 'Ist Verpflegung inbegriffen?'],
    ['kapazitaet_innen', 'telefon', 'besonderheiten', 'anlaesse'],
    ['(^|/)(meeting|meetings|seminar|seminare|seminarraum|seminarraeume|tagung|tagungen|konferenz|konferenzen|sitzung|sitzungen|workshops?)(/|$)']),
  typ('silvester', 'Silvester', 'Events',
    'Die Leserin möchte den Jahreswechsel hier verbringen und reserviert früh.',
    [['Silvester in {ort}', 'Datum, Ablauf, Menü, Preis nur aus den Fakten'],
     ['Der Abend', 'Apéro, Menü, Mitternacht'],
     ['Reservation', 'Fristen, Plätze, Zahlungsbedingungen aus den Fakten']],
    [150, 320],
    'Kurz vor Mitternacht: Gläser sind gefüllt, alle am Tisch zählen mit, draussen leuchtet der Himmel.',
    'Silvestertisch reservieren',
    ['Silvester {ort}', 'Silvestermenü {ort}', 'Silvesterdinner {ort}'],
    ['Was kostet das Silvestermenü?', 'Bis wann muss ich reservieren?', 'Gibt es ein vegetarisches Menü?'],
    ['reservation_url', 'telefon', 'oeffnungszeiten'],
    ['(^|/)(silvester|silvesterdinner|silvestermenu|silvestermenue|sylvester|neujahr|new-years-eve)(/|$)']),
  typ('weihnachten', 'Weihnachten', 'Events',
    'Die Leserin plant Weihnachtsessen im Familien-, Freundes- oder Firmenkreis und reserviert.',
    [['Weihnachten in {ort}', 'Zeitraum, Angebot, Menü aus den Fakten'],
     ['Weihnachtsessen für Gruppen', 'Firmen, Vereine, Familien'],
     ['Reservation', 'Fristen und Plätze aus den Fakten']],
    [150, 320],
    'Ein Winterabend: Kerzenlicht, Tannenduft, der Tisch füllt sich mit Menschen, die sich lange nicht gesehen haben.',
    'Weihnachtsessen reservieren',
    ['Weihnachtsessen {ort}', 'Weihnachtsmenü {ort}', 'Weihnachtsfeier {ort}'],
    ['Wann kann ich das Weihnachtsmenü bestellen?', 'Gibt es Angebote für Firmen?', 'Bis wann muss ich reservieren?'],
    ['reservation_url', 'telefon', 'kapazitaet_innen', 'anlaesse'],
    ['(^|/)(weihnacht|weihnachten|weihnachtsessen|weihnachtsmenu|weihnachtsmenue|weihnachtsfeier|weihnachtsfeiern|advent|christmas)(/|$)']),
  typ('events_aktion', 'Events und Aktionen', 'Events',
    'Die Leserin erfährt, was kommt, und merkt sich einen Termin.',
    [['Was bei uns läuft', 'Kommende Anlässe mit Datum aus den Fakten'],
     ['Regelmässige Angebote', 'Wiederkehrende Aktionen, nur belegt'],
     ['Dabei sein', 'Anmeldung und Reservation']],
    [120, 280],
    'Ein besonderer Abend im Haus: was an diesem Tag anders ist und wie es sich anfühlt, dabei zu sein.',
    'Platz sichern',
    ['Events {ort} Restaurant', 'Veranstaltungen {ort}', 'Aktion {restaurantName}'],
    ['Welche Veranstaltungen finden statt?', 'Muss ich mich anmelden?', 'Gibt es Gutscheine für Events?'],
    ['anlaesse', 'reservation_url', 'telefon'],
    ['(^|/)(events?|aktion|aktionen|angebote|veranstaltungen|agenda|news|specials|highlights|kalender)(/|$)']),
  typ('reservation', 'Reservation', 'Service',
    'Die Leserin reserviert ohne Rückfrage und weiss, was sie bei Gruppen oder Sonderwünschen tun muss.',
    [['Tisch reservieren', 'Wie die Reservation geht, Link oder Telefon'],
     ['Gruppen und Anlässe', 'Ab welcher Zahl, an wen wenden'],
     ['Gut zu wissen', 'Fristen, Stornierung, Allergien aus den Fakten']],
    [80, 180],
    'Der Moment der Vorfreude: der Tisch ist gebucht, der Abend kann kommen.',
    'Jetzt reservieren',
    ['{restaurantName} reservieren', 'Tisch reservieren {ort}'],
    ['Wie kann ich einen Tisch reservieren?', 'Kann ich online reservieren?', 'Bis wann kann ich stornieren?'],
    ['reservation_url', 'telefon', 'oeffnungszeiten'],
    ['(^|/)(reservation|reservationen|reservieren|tischreservation|booking|buchen|book|reserve)(/|$)']),
  typ('anreise_kontakt', 'Anreise und Kontakt', 'Service',
    'Die Leserin findet das Restaurant ohne Umweg und weiss, wie sie es erreicht.',
    [['So finden Sie uns', 'Adresse, Wegbeschreibung'],
     ['Anreise', 'Zug, Tram, Auto, Parkplätze aus den Fakten'],
     ['Kontakt', 'Telefon, Öffnungszeiten, Reservation']],
    [80, 200],
    'Der Weg zum Haus aus Gästesicht: das letzte Stück zu Fuss, das erste Licht an der Tür.',
    'Anrufen oder reservieren',
    ['{restaurantName} Adresse', '{restaurantName} Anfahrt', 'Restaurant {ort} Parkplatz'],
    ['Wo kann ich parken?', 'Wie komme ich mit dem öV hin?', 'Ist das Restaurant rollstuhlgängig?'],
    [...ADR, 'oeffnungszeiten'],
    ['(^|/)(anreise|anfahrt|kontakt|contact|so-finden-sie-uns|standort|lage|wegbeschreibung|adresse|oeffnungszeiten)(/|$)']),
  typ('team_karriere', 'Team und Karriere', 'Service',
    'Die Leserin sieht, wie hier gearbeitet wird, und bewirbt sich.',
    [['Arbeiten bei uns', 'Haltung, Arbeitsumfeld, Teamgrösse aus den Fakten'],
     ['Offene Stellen', 'Verweis auf aktuelle Stellen, sonst Lücke'],
     ['So bewerben Sie sich', 'Ansprechperson, Unterlagen']],
    [150, 320],
    'Ein Arbeitstag aus Sicht einer neuen Mitarbeiterin: der erste Handschlag im Team, das gemeinsame Essen vor dem Service.',
    'Jetzt bewerben',
    ['Jobs Gastronomie {ort}', 'Stellen Restaurant {ort}', 'Koch Stelle {ort}'],
    ['Welche Stellen sind offen?', 'Wie bewerbe ich mich?', 'Gibt es Lehrstellen?'],
    ['ort', 'telefon', 'besonderheiten'],
    ['(^|/)(team|karriere|jobs?|stellen|stellenangebote|offene-stellen|arbeiten-bei-uns|lehrstellen|careers)(/|$)']),
  typ('faq', 'Häufige Fragen', 'Service',
    'Die Leserin findet in einem Blick die Antwort auf ihre Frage und bleibt, statt anzurufen.',
    [['Reservation und Öffnungszeiten', 'Direkte Antworten in ein bis zwei Sätzen'],
     ['Küche und Besonderheiten', 'Allergien, vegetarisch, Kinder'],
     ['Anlässe und Anreise', 'Gruppen, Parkplätze, Zugang']],
    [200, 400],
    'Die kleine Unsicherheit vor dem Besuch, zum Beispiel ob ein Tisch für sechs Personen noch frei ist, und die klare Antwort darauf.',
    'Weitere Fragen? Rufen Sie uns an',
    ['{restaurantName} Fragen', '{ort} Restaurant Öffnungszeiten Reservation'],
    ['Wann haben Sie geöffnet?', 'Muss ich reservieren?', 'Gibt es vegetarische Gerichte?', 'Sind Hunde erlaubt?', 'Wo kann ich parken?', 'Kann ich einen Anlass bei Ihnen feiern?'],
    ['oeffnungszeiten', 'telefon', 'reservation_url', 'kueche'],
    ['(^|/)(faq|faqs|fragen|haeufige-fragen|haufige-fragen|fragen-und-antworten|hilfe)(/|$)']),
  typ('familien', 'Familien', 'Anlässe',
    'Die Leserin sieht, dass Kinder hier willkommen sind und der Besuch entspannt verläuft.',
    [['Mit Kindern bei uns', 'Angebot für Kinder, Kinderteller, Hochstühle aus den Fakten'],
     ['Platz und Ruhe', 'Raum, Spielecke, Zeiten'],
     ['Familienfeiern', 'Geburtstage, Reservation']],
    [120, 280],
    'Ein Familienbesuch: das Kind malt auf dem Tischset, die Eltern trinken in Ruhe einen Kaffee.',
    'Familientisch reservieren',
    ['Restaurant mit Kindern {ort}', 'Familienfreundliches Restaurant {ort}'],
    ['Gibt es einen Kinderteller?', 'Sind Hochstühle vorhanden?', 'Ab wann sind Kinder willkommen?'],
    ['besonderheiten', 'oeffnungszeiten', 'reservation_url'],
    ['(^|/)(familien|familie|kinder|family|kids|mit-kindern)(/|$)']),
  typ('terrasse', 'Terrasse', 'Kulinarik',
    'Die Leserin stellt sich einen Sommerabend auf der Terrasse vor und reserviert einen Platz.',
    [['Die Terrasse', 'Lage, Aussicht, Plätze aus den Fakten'],
     ['Essen und Trinken im Freien', 'Angebot, Zeiten, Wetterregel'],
     ['Reservation', 'Plätze draussen, Vorgehen bei Regen']],
    [100, 250],
    'Ein warmer Abend im Freien: Licht, das langsam weicher wird, Stimmen, ein kühles Glas.',
    'Platz auf der Terrasse reservieren',
    ['Terrasse {ort} Restaurant', 'Restaurant mit Garten {ort}', 'Sommerterrasse {ort}'],
    ['Wie viele Plätze hat die Terrasse?', 'Kann ich draussen reservieren?', 'Sind Hunde auf der Terrasse erlaubt?'],
    ['kapazitaet_terrasse', 'oeffnungszeiten', 'reservation_url', 'telefon'],
    ['(^|/)(terrasse|terrassen|garten|gartenwirtschaft|biergarten|aussenbereich|draussen)(/|$)']),
  typ('catering', 'Catering', 'Service',
    'Die Anfragerin erkennt, dass das Restaurant auch an ihrem Ort für gutes Essen sorgt, und fragt an.',
    [['Catering aus {ort}', 'Angebot, Gruppengrössen, Einzugsgebiet aus den Fakten'],
     ['Was wir liefern und aufbauen', 'Menüs, Buffets, Service, Geschirr'],
     ['So läuft die Bestellung ab', 'Anfrage, Offerte, Lieferung']],
    [150, 320],
    'Ein Anlass an einem anderen Ort: das Buffet steht, die Gäste bedienen sich, die Gastgeberin hat Zeit für alle.',
    'Catering anfragen',
    ['Catering {ort}', 'Partyservice {ort}', 'Apéro Catering {ort}'],
    ['Ab wie vielen Personen liefern Sie?', 'Liefern Sie auch Geschirr und Personal?', 'Wie weit im Voraus muss ich bestellen?'],
    ['telefon', 'anlaesse', 'kueche'],
    ['(^|/)(catering|partyservice|lieferservice|take-?away|aperoservice|buffet)(/|$)']),
  typ('gutscheine', 'Gutscheine', 'Service',
    'Die Leserin kauft einen Gutschein, weil sie versteht, was er dem Beschenkten bietet.',
    [['Geschenkidee Gutschein', 'Was der Gutschein bietet, Wert und Einlösung aus den Fakten'],
     ['So bestellen Sie', 'Online, Telefon, Abholung'],
     ['Gut zu wissen', 'Gültigkeit, Einlösung aus den Fakten']],
    [80, 200],
    'Der Moment des Schenkens: ein kleiner Umschlag, ein Lächeln, die Vorfreude auf einen gemeinsamen Abend.',
    'Gutschein bestellen',
    ['Gutschein Restaurant {ort}', 'Geschenkgutschein {ort}', '{restaurantName} Gutschein'],
    ['Wie lange ist der Gutschein gültig?', 'Wie bestelle ich einen Gutschein?', 'Kann ich einen Gutschein per Post erhalten?'],
    ['telefon', 'reservation_url', 'ort'],
    ['(^|/)(gutschein|gutscheine|geschenk|geschenke|geschenkgutschein|voucher|shop)(/|$)']),
  typ('gruppe_startseite', 'Gruppe: Startseite', 'Kern',
    'Die Leserin versteht, wofür die Gruppe steht, und findet das passende Restaurant.',
    [['Unsere Gruppe', 'Haltung und Gemeinsames der Häuser'],
     ['Unsere Restaurants', 'Kurzvorstellung jedes Hauses mit Ort und Küche'],
     ['Anlässe und Kontakt', 'Gemeinsame Anfragestelle aus den Fakten']],
    [180, 320],
    'Ein Abend, an dem man sich zwischen zwei Häusern entscheidet, und das Gefühl, dass beide zur selben Familie gehören.',
    'Restaurant wählen und reservieren',
    ['{restaurantName} Restaurants', 'Restaurantgruppe {ort}'],
    ['Welche Restaurants gehören zur Gruppe?', 'Wie erreiche ich die Gruppe für Anlässe?', 'Gibt es Gutscheine für alle Häuser?'],
    ['ort', 'telefon', 'gruendungsjahr', 'besonderheiten'],
    ['^/?(gruppe|group|unternehmen|startseite)?/?$']),
  typ('gruppe_restaurants_uebersicht', 'Gruppe: Restaurants Übersicht', 'Kern',
    'Die Leserin vergleicht die Häuser auf einen Blick und wählt eines zum Reservieren.',
    [['Unsere Restaurants', 'Jedes Haus mit Ort, Küche, Charakter in zwei bis drei Sätzen'],
     ['Welches Haus passt zu welchem Anlass', 'Orientierungshilfe für Mittag, Abend, Feier'],
     ['Reservation und Kontakt', 'Weg zur Reservation je Haus']],
    [150, 300],
    'Die Auswahl am Wochenende: Lust auf Terrasse, Lust auf Klassiker, jedes Haus trifft eine andere Stimmung.',
    'Restaurant wählen',
    ['Restaurants {ort}', '{restaurantName} Restaurants Übersicht'],
    ['Welches Restaurant eignet sich für Familien?', 'Welches Haus hat eine Terrasse?', 'Wo kann ich Anlässe feiern?'],
    ['ort', 'kueche', 'reservation_url'],
    ['(^|/)(restaurants|lokale|unsere-restaurants|haeuser|standorte|betriebe|locations)(/|$)']),
];

const SEITENTYPEN = Object.fromEntries(LISTE.map(t => [t.key, t]));

const SEITENSAETZE = {
  restaurant_standard: ['startseite', 'ueber_uns', 'mittag', 'bar_wein', 'bankette', 'silvester', 'hochzeit', 'faq'],
  restaurant_gross: ['startseite', 'ueber_uns', 'geschichte', 'speisekarte_intro', 'mittag', 'brunch', 'nachmittag_tea',
    'bar_wein', 'bankette', 'firmenanlass', 'privatanlass', 'hochzeit', 'meetings', 'silvester', 'weihnachten',
    'events_aktion', 'reservation', 'anreise_kontakt', 'team_karriere', 'faq', 'familien', 'terrasse', 'catering', 'gutscheine'],
  restaurant_klein: ['startseite', 'ueber_uns', 'mittag', 'faq'],
  gruppe: ['gruppe_startseite', 'gruppe_restaurants_uebersicht', 'ueber_uns', 'team_karriere'],
};

// Reihenfolge der Prüfung: spezifische Typen vor allgemeinen, die Gruppen-Startseite zuletzt
const PRUEF_REIHENFOLGE = ['firmenanlass', 'privatanlass', 'hochzeit', 'silvester', 'weihnachten', 'meetings', 'bankette',
  'brunch', 'nachmittag_tea', 'mittag', 'bar_wein', 'speisekarte_intro', 'terrasse', 'familien', 'catering', 'gutscheine',
  'reservation', 'anreise_kontakt', 'team_karriere', 'faq', 'geschichte', 'ueber_uns', 'events_aktion',
  'gruppe_restaurants_uebersicht', 'startseite', 'gruppe_startseite'];

// Wandelt eine URL oder einen Pfad in eine vergleichbare Form: Kleinbuchstaben, ohne Host, Sprachpräfix und Endung
function normalisierePfad(pfad) {
  let p = String(pfad || '').trim().toLowerCase().replace(/^[a-z]+:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  p = p.replace(/\.(html?|php)$/, '').replace(/\/+$/, '');
  p = p.replace(/^\/(de|en|fr|it)(-[a-z]{2})?(?=\/|$)/, '');
  return p === '' ? '/' : (p.startsWith('/') ? p : '/' + p);
}

// Ordnet einen Seitenpfad einem Seitentyp zu, sonst null
function seitentypFuerPfad(pfad) {
  const p = normalisierePfad(pfad);
  const norm = p === '/' ? '' : p;
  for (const key of PRUEF_REIHENFOLGE) {
    // gruppe_startseite hat dasselbe Muster wie die Startseite und wird nur über SEITENSAETZE gewählt
    if (key === 'gruppe_startseite') continue;
    if (SEITENTYPEN[key].pfadMuster.some(m => new RegExp(m).test(norm))) return key;
  }
  return null;
}

const FAKTEN_NAMEN = {
  strasse: 'Strasse', plz: 'PLZ', ort: 'Ort', telefon: 'Telefon', oeffnungszeiten: 'Öffnungszeiten', kueche: 'Küche',
  reservation_url: 'Reservationslink', kapazitaet_innen: 'Plätze innen', kapazitaet_terrasse: 'Plätze Terrasse',
  anlaesse: 'Anlässe', kuechenchef: 'Küchenchef', gruendungsjahr: 'Gründungsjahr', besonderheiten: 'Besonderheiten',
  auszeichnungen: 'Auszeichnungen',
};

function ersetzePlatzhalter(s, ctx) {
  return String(s)
    .replace(/\{ort\}/g, ctx.ort || '[Ort]')
    .replace(/\{kueche\}/g, ctx.kueche || '[Küche]')
    .replace(/\{restaurantName\}/g, ctx.restaurantName || '[Restaurantname]');
}

// Gedankenstriche dürfen in keinem Prompt stehen, auch nicht aus Eingaben
function ohneGedankenstriche(s) {
  return s.replace(/\s*[–—]\s*/g, ', ');
}

// Anweisung für den KI-Auftrag zu einem Seitentyp (Deutsch)

// Englische Fassung der Anweisung (British English, Corporate). Die Daten des Seitentyps sind deutsch; das Modell übersetzt Überschriften und Suchbegriffe sinngemäss.
function promptFuerEn(t, c) {
  const L = [];
  L.push(`PAGE TYPE: ${t.label} (German type name)`);
  L.push(`Restaurant: ${c.restaurantName || '[restaurant name]'}${c.ort ? ', ' + c.ort : ''}${c.kueche ? ', cuisine: ' + c.kueche : ''}`);
  L.push('OUTPUT LANGUAGE: British English. Write the whole page in natural British English. The structure data below is in German: translate the H2 headings, search terms and FAQ questions into natural English equivalents. The header lines (TITEL:, BESCHREIBUNG:, H1:, TEXT:, H2:, FAQ:, F:, A:) stay exactly as written, because a program reads them.');
  L.push('');
  L.push(`GOAL OF THE PAGE: ${t.ziel}`);
  L.push('');
  L.push('STRUCTURE (one H1, then the H2 sections in this order):');
  L.push('H1: contains the main search term and names the place or the restaurant.');
  t.aufbau.forEach(a => L.push(`H2: ${ersetzePlatzhalter(a.h2, c)}  (content: ${a.inhalt})`));
  L.push('');
  L.push(`LENGTH: ${t.laengeWoerter[0]} to ${t.laengeWoerter[1]} words in the TEXT part (without the FAQ).`);
  L.push('');
  L.push(`OPENING: ${t.einstieg} The first paragraph begins as a scene from the guest\'s point of view with one concrete sensory detail: personal, from one person to another, free of stock phrases. The main search term appears in the first paragraph.`);
  L.push('');
  L.push('AT A GLANCE: You do NOT write this block. It is generated from the structured facts. Do not repeat the data it contains (address, opening hours, telephone) as a list in the text.');
  if (c.aufEinenBlickZeilen && c.aufEinenBlickZeilen.length) {
    L.push('The block will later contain these lines (for orientation, do not copy):');
    c.aufEinenBlickZeilen.forEach(z => L.push('- ' + z));
  }
  L.push('');
  L.push('SEARCH TERMS (choose the best fit as the main term, work the others in naturally):');
  t.suchbegriffe.forEach(x => L.push('- ' + ersetzePlatzhalter(x, c)));
  L.push('');
  L.push('FAQ: Answer these questions in one to three sentences each, starting directly with the answer. Add at most two more questions that guests of this page really ask.');
  t.faqFragen.forEach(f => L.push('- ' + f));
  L.push('');
  L.push(`CALL TO ACTION: The text ends with one clear next step: ${t.cta}. Name the way (link, telephone) only if it is in the facts, otherwise leave a gap.`);
  L.push('');
  L.push('SEARCH ENGINE: TITEL at most 60 characters. BESCHREIBUNG between 120 and 155 characters. Both contain the main search term and make people want to visit. Count the characters.');
  L.push('');
  L.push('FACTS NEEDED FOR THIS PAGE: ' + t.pflichtFakten.map(k => FAKTEN_NAMEN[k] || k).join(', ') + '.');
  if (c.faktenText) { L.push('FACTS FROM THE REQUEST (the only source for facts):'); L.push(c.faktenText); }
  else L.push('FACTS FROM THE REQUEST: none given. For every fact you need, insert a [gap: what is missing] in square brackets.');
  if (c.stichworte) { L.push('KEYWORDS AND WISHES:'); L.push(Array.isArray(c.stichworte) ? c.stichworte.join(', ') : c.stichworte); }
  L.push('');
  if (c.bestehenderText && String(c.bestehenderText).trim()) {
    L.push('EXISTING TEXT (revise instead of rewriting: keep what is good and accurate, adapt structure and style to the instructions above, take facts only from the facts of the request, mark anything in the existing text that differs as [gap]):');
    L.push('"""'); L.push(String(c.bestehenderText).trim()); L.push('"""');
    L.push('');
  }
  L.push('RULES:');
  L.push('- Only facts from the request. If a fact is missing, write [gap: what is missing] in square brackets. Invent nothing.');
  L.push('- No superlatives without evidence.');
  L.push('- No stock phrases such as "welcome to", "unforgettable", "culinary delights", "pure indulgence", "pamper yourself".');
  L.push('- No em dashes and no en dashes in running text. Use a comma, a full stop or a colon.');
  L.push('- British English spelling (-ise, colour, programme). Address guests as "you".');
  L.push('- Sentences flow: never join two complete main clauses with a comma alone; use a full stop or a conjunction.');
  L.push('- No Markdown except the header lines named below.');
  L.push('');
  L.push('OUTPUT FORMAT (strict, exactly these header lines in this order):');
  L.push('TITEL: <at most 60 characters>');
  L.push('BESCHREIBUNG: <120 to 155 characters>');
  L.push('H1: <heading>');
  L.push('TEXT:');
  L.push('<opening paragraph>');
  L.push('H2: <subheading>');
  L.push('<paragraphs>');
  L.push('FAQ:');
  L.push('F: <question>');
  L.push('A: <answer>');
  return ohneGedankenstriche(L.join('\n'));
}

function promptFuer(seitentypKey, ctx = {}) {
  const t = SEITENTYPEN[seitentypKey];
  if (!t) throw new Error('Unbekannter Seitentyp: ' + seitentypKey);
  const c = ctx || {};
  if (c.sprache && /^en/i.test(c.sprache)) return promptFuerEn(t, c);
  const L = [];
  L.push(`SEITENTYP: ${t.label}`);
  L.push(`Restaurant: ${c.restaurantName || '[Restaurantname]'}${c.ort ? ', ' + c.ort : ''}${c.kueche ? ', Küche: ' + c.kueche : ''}`);
  if (c.sprache && !/^de/i.test(c.sprache)) L.push(`Ausgabesprache: ${c.sprache}. Die Kopfzeilen (TITEL:, BESCHREIBUNG:, H1:, TEXT:, H2:, FAQ:, F:, A:) bleiben unverändert.`);
  L.push('');
  L.push(`ZIEL DER SEITE: ${t.ziel}`);
  L.push('');
  L.push('AUFBAU (eine H1, dann die H2-Abschnitte in dieser Reihenfolge):');
  L.push('H1: enthält den Hauptsuchbegriff und nennt Ort oder Restaurant.');
  t.aufbau.forEach(a => L.push(`H2: ${ersetzePlatzhalter(a.h2, c)}  (Inhalt: ${a.inhalt})`));
  L.push('');
  L.push(`LÄNGE: ${t.laengeWoerter[0]} bis ${t.laengeWoerter[1]} Wörter im TEXT-Teil (ohne FAQ).`);
  L.push('');
  L.push(`EINSTIEG: ${t.einstieg} Der erste Absatz beginnt bei der Leserin als Szene aus Gästesicht mit einem konkreten Sinneseindruck, emotional, persönlich, von Mensch zu Mensch, ohne Floskeln. Der Hauptsuchbegriff steht im ersten Absatz.`);
  L.push('');
  L.push('AUF EINEN BLICK: Diesen Block schreibst du NICHT. Er wird aus den strukturierten Fakten erzeugt. Wiederhole darin stehende Daten (Adresse, Öffnungszeiten, Telefon) nicht als Liste im Text.');
  if (c.aufEinenBlickZeilen && c.aufEinenBlickZeilen.length) {
    L.push('Der Block enthält später diese Zeilen (zur Orientierung, nicht abschreiben):');
    c.aufEinenBlickZeilen.forEach(z => L.push('- ' + z));
  }
  L.push('');
  L.push('SUCHBEGRIFFE (wähle den passendsten als Hauptbegriff, die anderen verteilt und natürlich einsetzen):');
  t.suchbegriffe.forEach(s => L.push('- ' + ersetzePlatzhalter(s, c)));
  L.push('');
  L.push('FAQ: Beantworte diese Fragen in je ein bis drei Sätzen, direkt mit der Antwort beginnend. Ergänze höchstens zwei weitere Fragen, die Gäste dieser Seite wirklich stellen.');
  t.faqFragen.forEach(f => L.push('- ' + f));
  L.push('');
  L.push(`CALL-TO-ACTION: Der Text endet mit einem klaren nächsten Schritt: ${t.cta}. Nenne den Weg (Link, Telefon) nur, wenn er in den Fakten steht, sonst eine Lücke.`);
  L.push('');
  L.push('SUCHMASCHINE: TITEL höchstens 60 Zeichen. BESCHREIBUNG zwischen 120 und 155 Zeichen. Beide enthalten den Hauptsuchbegriff und machen Lust auf den Besuch. Zähle die Zeichen nach.');
  L.push('');
  L.push('FAKTEN, DIE FÜR DIESE SEITE GEBRAUCHT WERDEN: ' + t.pflichtFakten.map(k => FAKTEN_NAMEN[k] || k).join(', ') + '.');
  if (c.faktenText) { L.push('FAKTEN AUS DEM AUFTRAG (einzige Quelle für Fakten):'); L.push(c.faktenText); }
  else L.push('FAKTEN AUS DEM AUFTRAG: keine angegeben. Setze für jede benötigte Angabe eine [Lücke in eckigen Klammern].');
  if (c.stichworte) { L.push('STICHWORTE UND WÜNSCHE:'); L.push(Array.isArray(c.stichworte) ? c.stichworte.join(', ') : c.stichworte); }
  L.push('');
  if (c.bestehenderText && String(c.bestehenderText).trim()) {
    L.push('BESTEHENDER TEXT (überarbeiten statt neu schreiben: Gutes und Treffendes übernehmen, Aufbau und Stil an die Vorgaben oben anpassen, Fakten nur aus den Fakten des Auftrags, Abweichendes im bestehenden Text als [Lücke] markieren):');
    L.push('"""'); L.push(String(c.bestehenderText).trim()); L.push('"""');
    L.push('');
  }
  L.push('REGELN:');
  L.push('- Nur Fakten aus dem Auftrag. Fehlt eine Angabe, schreibe [Lücke: was fehlt] in eckigen Klammern. Erfinde nichts.');
  L.push('- Keine Superlative ohne Beleg.');
  L.push('- Keine Floskeln wie «herzlich willkommen», «unvergesslich», «kulinarische Perlen», «Genuss pur», «lassen Sie sich verwöhnen».');
  L.push('- Keine langen Gedankenstriche und keine kurzen Striche im Fliesstext. Nimm Komma, Punkt oder Doppelpunkt.');
  L.push('- Schweizer Schreibweise: immer ss (Strasse, Grösse), Umlaute als ä, ö, ü.');
  L.push('- Sprich die Gäste mit Sie an, sofern der Auftrag nichts anderes verlangt.');
  L.push('- Sätze fliessen: verbinde zwei vollständige Hauptsätze nie nur mit einem Komma, setze einen Punkt oder «und», «denn», «weil», «damit».');
  L.push('- Vor «und» steht kein Komma (Schweizer Schreibweise), ausser wo ein Nebensatz oder Einschub endet.');
  L.push('- Kein Markdown ausser den unten genannten Kopfzeilen.');
  L.push('');
  L.push('AUSGABEFORMAT (strikt, genau diese Kopfzeilen in dieser Reihenfolge):');
  L.push('TITEL: <höchstens 60 Zeichen>');
  L.push('BESCHREIBUNG: <120 bis 155 Zeichen>');
  L.push('H1: <Überschrift>');
  L.push('TEXT:');
  L.push('<Einstiegsabsatz>');
  L.push('H2: <Zwischenüberschrift>');
  L.push('<Absätze>');
  L.push('FAQ:');
  L.push('F: <Frage>');
  L.push('A: <Antwort>');
  return ohneGedankenstriche(L.join('\n'));
}

// Liest die KI-Ausgabe im Format TITEL/BESCHREIBUNG/H1/TEXT/FAQ; toleriert fehlende Teile, Markdown und Leerzeilen
function parseAusgabe(text) {
  const out = { titel: '', beschreibung: '', h1: '', h2: [], text: '', faq: [], luecken: [] };
  const roh = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const zeilen = roh.split('\n');
  let modus = null;
  const textZeilen = [];
  let frage = null;
  let letzteAntwort = null;
  const kopf = /^\s*[*#_\s]*(TITEL|BESCHREIBUNG|H1|TEXT|FAQ)[*_\s]*:[*_\s]*(.*)$/i;
  for (const z of zeilen) {
    const m = z.match(kopf);
    if (m) {
      const k = m[1].toUpperCase(); const rest = m[2].trim();
      if (k === 'TITEL') { out.titel = rest; modus = 'titel'; continue; }
      if (k === 'BESCHREIBUNG') { out.beschreibung = rest; modus = 'beschreibung'; continue; }
      if (k === 'H1') { out.h1 = rest; modus = 'h1'; continue; }
      if (k === 'TEXT') { modus = 'text'; if (rest) textZeilen.push(rest); continue; }
      if (k === 'FAQ') { modus = 'faq'; continue; }
    }
    if (modus === 'text') {
      const h = z.match(/^\s*[*#_\s]*H2[*_\s]*:[*_\s]*(.+)$/i);
      if (h) out.h2.push(h[1].trim());
      textZeilen.push(z);
    } else if (modus === 'faq') {
      const f = z.match(/^\s*[*_\s-]*F[*_\s]*:[*_\s]*(.*)$/);
      const a = z.match(/^\s*[*_\s-]*A[*_\s]*:[*_\s]*(.*)$/);
      if (f) { frage = { frage: f[1].trim(), antwort: '' }; out.faq.push(frage); letzteAntwort = null; }
      else if (a) {
        if (!frage || frage.antwort) { frage = { frage: '', antwort: '' }; out.faq.push(frage); }
        frage.antwort = a[1].trim(); letzteAntwort = frage;
      } else if (z.trim() && letzteAntwort) letzteAntwort.antwort += ' ' + z.trim();
    } else if ((modus === 'titel' || modus === 'beschreibung') && z.trim()) {
      out[modus] += ' ' + z.trim();
    }
  }
  out.text = textZeilen.join('\n').trim();
  out.titel = out.titel.trim(); out.beschreibung = out.beschreibung.trim();
  // Lücken in allen Teilen sammeln
  const alles = [out.titel, out.beschreibung, out.h1, out.text, ...out.faq.map(f => f.frage + ' ' + f.antwort)].join('\n');
  out.luecken = (alles.match(/\[[^\[\]]+\]/g) || []);
  return out;
}

module.exports = { SEITENTYPEN, SEITENSAETZE, FAKTEN_KEYS, seitentypFuerPfad, promptFuer, parseAusgabe };
