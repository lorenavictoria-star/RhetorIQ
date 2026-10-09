// Notfallkarte (eine Seite zum Ausdrucken) und Notfallordner für die Vertretung als Word.
// Inhalt der Notfallkarte aus dem Ausfallbericht (AUDIT_Sicherheit_Ausfall.md), nur Rechtschreibung angepasst.
// Keine Passwörter, keine Schlüssel, nur öffentliche Adressen der Statusseiten.
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, PageBreak
} = require('docx');

const KARTE = {
  titel: 'Notfallkarte',
  hinweis: 'Diese Seite enthält keine Passwörter.',
  intro: 'Wenn etwas brennt: Ruhig atmen. Zuerst feststellen WAS ausfällt, dann handeln. Nichts löschen. Notizen mit Uhrzeit führen.',
  tabelleKopf: ['Symptom', 'Zuerst prüfen', 'Dann tun'],
  tabelle: [
    ['Plattform lädt nicht', 'rhetoriq.ch/health im Browser; Statusseite von Render; Render-Konsole, Logs, letzter Deploy', 'Letzten Deploy zurückrollen; Klienten informieren (Textbaustein 1)'],
    ['Plattform läuft, Texte werden nicht erzeugt', 'Statusseite von Anthropic; Guthaben und Karte im Anthropic-Konto; Fehlerliste (generation_errors)', 'Hinweis in der Plattform; Reservekonto einschalten (Seite Nutzung); sonst von Hand mit Stimmenmappe (Textbaustein 2)'],
    ['Mails kommen nicht an', 'Status von Brevo; Admin-Seite der E-Mail-Warteschlange; Spam-Ordner', 'Warteschlange erneut senden; dringende Mails von Hand'],
    ['Zahlung oder Abo stimmt nicht', 'Stripe-Dashboard, Webhook-Zustellungen', 'Klienten von Hand auf «aktiv» setzen (Funktion mark-active)'],
    ['Fremder Zugriff vermutet', 'Neue Konten, Zahlungslinks, Klienten, Rechnungen', 'Szenario 5: Geheimnis und Passwort in Render ändern, alle Schlüssel erneuern, Dienste prüfen'],
    ['Daten fehlen', 'Render, Datenbank, Backups; Brand-Voice-Versionen im Programm', 'Letztes Backup einspielen (Anhang C), Klienten informieren'],
    ['Ich selbst falle aus', 'Notfallordner bei der Vertrauensperson', 'Vertretung übernimmt: Klienten informieren, Dienste laut Liste prüfen']
  ],
  sechzigTitel: 'Die ersten 60 Minuten in dieser Reihenfolge',
  sechzig: [
    'Was fällt aus? (Login, Texte, Mails, Zahlung?) Eine Zeile aufschreiben.',
    'Betrifft es alle oder einzelne? Eigene Anmeldung und eine Klientenansicht testen.',
    'Statusseiten der Dienste ansehen (Render, Anthropic, Brevo, Stripe, GitHub).',
    'Letzte Änderung rückgängig machen, falls ein Deploy kurz vorher war.',
    'Klienten informieren (Textbaustein), Frist für die nächste Meldung nennen.',
    'Dringende Aufträge von Hand erledigen.',
    'Nach der Behebung: Testtext erzeugen, Mail testen, Entwarnung senden, Ursache notieren.'
  ],
  bereitTitel: 'Vorbereitet halten (vierteljährlich abhaken)',
  bereit: [
    'Notfallordner vollständig und aktuell (Zugänge, Wiederherstellungscodes, Ansprechpersonen)',
    'Letzte Stimmenmappe vom: ______ (Datum)',
    'Letzter erfolgreicher Wiederherstellungstest vom: ______ (Datum)',
    'Wächter meldet: grün seit ______',
    'Anthropic: Guthaben, automatische Aufladung, Monatslimit gesetzt',
    'Zwei-Faktor aktiv bei: Render, GitHub, Stripe, Anthropic, Brevo, Domain-Anbieter, Postfach',
    'Zweite Person mit Zugang eingewiesen: ______ (Name)'
  ],
  adressen: 'Wichtige Adressen: Alle Zugangsdaten stehen im Passwort-Manager und im Notfallordner; auf dieser Karte stehen keine Geheimnisse.',
  links: [
    { name: 'Statusseite Anthropic (KI)', url: 'https://status.anthropic.com' },
    { name: 'Statusseite Render (Plattform und Datenbank)', url: 'https://status.render.com' },
    { name: 'Statusseite Stripe (Zahlungen)', url: 'https://status.stripe.com' }
  ],
  bausteine: [
    {
      titel: 'Textbaustein 1, Störungsmeldung an Klienten',
      text: 'Guten Tag [Name]\nDie Plattform RhetorIQ ist im Moment gestört. Ich arbeite an der Behebung und melde mich spätestens um [Uhrzeit] mit dem Stand. Dringende Texte schreibe ich Ihnen in dieser Zeit persönlich. Schreiben Sie mir dazu einfach kurz Anlass, Empfänger und Frist.\nFreundliche Grüsse\nLorena Lienhard'
    },
    {
      titel: 'Textbaustein 2, Hinweis bei ausgefallener Textgenerierung',
      text: 'Guten Tag [Name]\nDie automatische Texterstellung steht kurzfristig nicht zur Verfügung. Ihre Stimme und Ihre Vorgaben sind gesichert, ich schreibe Ihre Texte vorübergehend selbst. Bitte senden Sie Ihren Auftrag wie gewohnt über «An Beraterin senden». Die Frist bleibt bestehen.\nFreundliche Grüsse\nLorena Lienhard'
    },
    {
      titel: 'Textbaustein 3, Entwarnung',
      text: 'Guten Tag [Name]\nDie Plattform läuft wieder normal. Die Störung dauerte von [Uhrzeit] bis [Uhrzeit]. Bereits erfasste Texte und Ihre Vorgaben sind vollständig vorhanden. Falls Ihnen etwas fehlt, melden Sie sich bitte direkt bei mir.\nFreundliche Grüsse\nLorena Lienhard'
    }
  ]
};

// ── Word-Bausteine ──────────────────────────────────────────────────────────
const FONT = 'Arial';
const run = (text, o = {}) => new TextRun({ text: String(text), font: FONT, size: o.size || 20, bold: o.bold, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after == null ? 100 : o.after }, children: [run(text, o)] });
const lines = (text, o = {}) => String(text).split('\n').map(l => p(l, { ...o, after: 40 }));
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: [run(t, { size: 28, bold: true })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 }, children: [run(t, { size: 22, bold: true })] });
const bullet = t => new Paragraph({ spacing: { after: 50 }, indent: { left: 360, hanging: 240 }, children: [run('•  ' + t)] });
const check = t => new Paragraph({ spacing: { after: 50 }, indent: { left: 360, hanging: 300 }, children: [run('☐  ' + t)] });
const numbered = (n, t) => new Paragraph({ spacing: { after: 50 }, indent: { left: 400, hanging: 400 }, children: [run(n + '.  ' + t)] });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(text, w, head) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA }, borders,
    shading: head ? { fill: 'E8E1CF', type: ShadingType.CLEAR } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: String(text).split('\n').map(l => new Paragraph({ children: [run(l, { size: 18, bold: !!head })] }))
  });
}
function table(widths, head, rows) {
  return new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ children: head.map((t, i) => cell(t, widths[i], true)) }), ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, widths[i])) }))]
  });
}
const page = (children) => ({ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children });

async function buildNotfallkarte() {
  const k = KARTE, kids = [];
  kids.push(new Paragraph({ spacing: { after: 40 }, children: [run(k.titel, { size: 40, bold: true })] }));
  kids.push(p(k.hinweis, { bold: true, after: 100 }));
  kids.push(p(k.intro, { after: 140 }));
  kids.push(table([2300, 3900, 3800], k.tabelleKopf, k.tabelle));
  kids.push(h2(k.sechzigTitel));
  k.sechzig.forEach((t, i) => kids.push(numbered(i + 1, t)));
  kids.push(h2(k.bereitTitel));
  k.bereit.forEach(t => kids.push(check(t)));
  kids.push(p(k.adressen, { after: 120 }));
  kids.push(h2('Statusseiten (öffentlich)'));
  k.links.forEach(l => kids.push(bullet(`${l.name}: ${l.url}`)));
  kids.push(new Paragraph({ children: [new PageBreak()] }));
  kids.push(h1('Textbausteine für den Notfall'));
  kids.push(p('Entwürfe, bitte an die eigene Stimme anpassen.', { after: 120 }));
  k.bausteine.forEach(b => { kids.push(h2(b.titel)); kids.push(...lines(b.text)); });
  return Packer.toBuffer(new Document({ creator: 'RhetorIQ', title: 'RhetorIQ Notfallkarte', sections: [page(kids)] }));
}

// ── Notfallordner für die Vertretung ────────────────────────────────────────
const DIENSTE = [
  ['Render', 'Webdienst und Datenbank der Plattform', 'Teammitglied mit eigener Anmeldung; Zugriff auf Logs, Rollback, Umgebungsvariablen und Datenbank-Backups'],
  ['GitHub', 'Quellcode und Auslöser der Deploys', 'Mitglied oder Mitarbeitende mit eigener Anmeldung am Repository'],
  ['Domain und DNS (rhetoriq.ch, Hostpoint)', 'Erreichbarkeit der Adresse, Umstellung bei einem Neuaufbau', 'Zweiter Benutzer beim Anbieter oder Zugang über den Notfallzugriff des Passwort-Managers'],
  ['Stripe', 'Zahlungen, Abos, Kundenportal, Webhook', 'Benutzer mit eigener Anmeldung und eingeschränkter Rolle'],
  ['Anthropic', 'KI für alle Texte, Guthaben, Schlüssel, Reservekonto', 'Zugang zur Konsole mit Rechnungsangaben; Reservekonto und Schlüssel getrennt ablegen'],
  ['Brevo', 'Versand der Mails (Einladungen, Freigaben, Berichte)', 'Benutzer mit eigener Anmeldung'],
  ['AssemblyAI', 'Transkription von Audio und Video', 'Zugang zur Konsole'],
  ['Sentry', 'Fehlerüberwachung', 'Benutzer mit eigener Anmeldung']
];

async function buildNotfallordner() {
  const kids = [];
  kids.push(new Paragraph({ spacing: { after: 40 }, children: [run('Notfallordner für die Vertretung', { size: 40, bold: true })] }));
  kids.push(p('RhetorIQ, Lorena Lienhard. Dieses Dokument enthält keine Passwörter und keine Schlüssel.', { bold: true, after: 140 }));

  kids.push(h1('1. Wann gilt dieser Ordner?'));
  kids.push(p('Wenn Lorena für mehrere Tage nicht erreichbar ist (Krankheit, Unfall, Ferien ohne Netz) oder die Plattform in dieser Zeit gestört ist. Die Vertretung hält die Klienten informiert und stellt sicher, dass die wichtigsten Dienste laufen.'));

  kids.push(h1('2. Welche Zugänge die Vertrauensperson kennen muss'));
  kids.push(p('Die Zugangsdaten stehen nur im Passwort-Manager mit Notfallzugriff. Hier steht, wofür jeder Zugang gebraucht wird und wie die Vertretung ihn bekommen soll.'));
  kids.push(table([2200, 3300, 4500], ['Dienst', 'Wofür', 'Zugang für die Vertretung'], DIENSTE));
  kids.push(p('', { after: 60 }));
  kids.push(h2('Checkliste'));
  DIENSTE.forEach(d => kids.push(check(`${d[0]}: eigener Zugang eingerichtet, Zwei-Faktor vorbereitet, Wiederherstellungscodes im Ordner`)));
  kids.push(check('Liste der Umgebungsvariablen (nur Namen und Ort der Werte) im Ordner'));
  kids.push(check('Aktuelle Stimmenmappen aller Klienten (ZIP aus der Seite Nutzung) im Ordner'));
  kids.push(check('Notfallkarte ausgedruckt im Ordner'));
  kids.push(check('Letzter Wiederherstellungstest des Backups mit Datum notiert'));

  kids.push(h1('3. Wo der Notfallordner liegt'));
  kids.push(bullet('Digital: im Passwort-Manager mit Notfallzugriff. Die Vertrauensperson wird dort als Notfallkontakt eingetragen und erhält den Zugang erst nach einer Wartefrist oder auf Freigabe.'));
  kids.push(bullet('Auf Papier: ein verschlossener Umschlag bei der Vertrauensperson mit der Notfallkarte, den Ansprechpersonen und dem Hinweis, wo der Notfallzugriff beantragt wird.'));
  kids.push(bullet('Nie im Dokument: Passwörter, Schlüssel, Wiederherstellungscodes im Klartext. Diese stehen ausschliesslich im Passwort-Manager.'));
  kids.push(bullet('Der private Schlüssel zum Entschlüsseln der Backups liegt an einem anderen Ort als die Backups.'));

  kids.push(h1('4. Was die Vertretung in den ersten 24 Stunden tut'));
  ['Abwesenheitsmeldung an die Klienten senden (Textbaustein unten).', 'Auf rhetoriq.ch/health prüfen, ob die Plattform läuft.', 'Auf der Seite Nutzung den Hinweis zur Störung prüfen und bei Bedarf einschalten.', 'Statusseiten von Render, Anthropic und Stripe ansehen.', 'Bei einem Ausfall die Notfallkarte abarbeiten.', 'Eingehende Anfragen der Webseite sichten und eine Eingangsbestätigung mit Frist senden.', 'Dringende Aufträge mit den Stimmenmappen und dem Handbuch von Hand erledigen, soweit die Vertretung dazu in der Lage ist, sonst Fristen mit den Klienten verschieben.']
    .forEach((t, i) => kids.push(numbered(i + 1, t)));

  kids.push(h1('5. Abwesenheitsmeldung (Textbaustein)'));
  kids.push(...lines('Guten Tag [Name]\nIch bin vom [Datum] bis [Datum] nicht erreichbar. Texte, die Sie über die Plattform erstellen, funktionieren wie gewohnt. Freigaben durch mich erfolgen nach meiner Rückkehr; in dringenden Fällen wenden Sie sich bitte an [Vertretung, Kontakt].\nFreundliche Grüsse\nLorena Lienhard'));

  kids.push(h1('6. Wer die Klienten informiert'));
  kids.push(table([3000, 3500, 3500], ['Klient', 'Wer informiert', 'Kontakt und Frist'], [
    ['Flaga', '[Name der Vertretung]', '[Ansprechperson bei Flaga, Telefon, Frist für die nächste Meldung]'],
    ['Weitere Klienten', '[Name der Vertretung]', 'Liste der Klienten mit Ansprechpersonen aus der Klientenliste in RhetorIQ'],
    ['Interessentinnen aus Anfragen', '[Name der Vertretung]', 'Antwort mit Eingangsbestätigung und genannter Frist']
  ]));
  kids.push(p('', { after: 60 }));
  kids.push(p('Absprache mit Flaga: Wer ist Ansprechperson bei längerem Ausfall, und welche Frist gilt dann? Das wird vorab geklärt und hier eingetragen.'));

  kids.push(h1('7. Ansprechpersonen'));
  kids.push(table([3000, 3500, 3500], ['Rolle', 'Name', 'Erreichbarkeit'], [
    ['Vertrauensperson', '', ''],
    ['Technische Hilfe (Fachperson)', '', ''],
    ['Rechtliche Beratung', '', ''],
    ['Steuer und Buchhaltung', '', '']
  ]));
  kids.push(p('', { after: 60 }));
  kids.push(p('Stand dieses Dokuments: ______ (Datum). Überprüfung vierteljährlich zusammen mit der Notfallkarte.'));

  return Packer.toBuffer(new Document({ creator: 'RhetorIQ', title: 'RhetorIQ Notfallordner Vertretung', sections: [page(kids)] }));
}

module.exports = { KARTE, DIENSTE, buildNotfallkarte, buildNotfallordner };
