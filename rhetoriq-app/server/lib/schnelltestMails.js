// Mails des Tests «Wie klingt Ihre Firma?»: Hinweis an Lorena (Du) und Begleitmail an die Firma (Sie, von Lorena bearbeitbar).
const appUrl = () => (process.env.APP_URL || 'https://rhetoriq.ch').replace(/\/$/, '');
const komma = (n) => String(n).replace('.', ',');

function kennzahlenZeilen(k) {
  if (!k) return ['Kennzahlen: nicht berechnet'];
  const z = [];
  if (k.woerterProSatz != null) z.push(`Wörter pro Satz: ${komma(k.woerterProSatz)}`, `Sätze über 25 Wörter: ${k.anteilLangeSaetze} Prozent`);
  if (k.wir != null) z.push(`Wir-Wörter zu Sie-Wörtern: ${k.wir} zu ${k.sie}`);
  if (k.floskeln) z.push(`Floskeln: ${k.floskeln.treffer} Treffer${k.floskeln.liste && k.floskeln.liste.length ? ' (' + k.floskeln.liste.slice(0, 4).map(x => x.floskel).join(', ') + ')' : ''}`);
  if (k.nominalstil) z.push(`Nominalstil (Näherung): ${komma(k.nominalstil.anteil)} Prozent`);
  if (k.passiv) z.push(`Passiv (Näherung): ${k.passiv.anteil} Prozent`);
  return z.length ? z : ['Kennzahlen: zu wenig Text für verlässliche Zahlen'];
}

// Hinweis an Lorena. a = { id, url, host, email, kennzahlen, kandidaten, mehrseiten }
function hinweisMail(a) {
  const kand = (a.kandidaten || []).map((c, i) => `${i + 1}. [${c.kategorie}${c.automatisch ? ', automatisch' : ''}] ${c.titel}`);
  return {
    subject: `Neuer Test «Wie klingt Ihre Firma?»: ${a.host}`,
    text: [
      'Hallo Lorena', '',
      'Ein Test «Wie klingt Ihre Firma?» wurde ausgefüllt und die tiefe Analyse ist fertig.', '',
      `Webseite: ${a.url}`, `E-Mail: ${a.email}`, `Gelesene Seiten: ${a.mehrseiten || 1}`, '',
      'Kennzahlen:', ...kennzahlenZeilen(a.kennzahlen).map(x => '  ' + x), '',
      kand.length ? 'Auffälligkeiten (Kurzform):' : 'Es liegen noch keine Auffälligkeiten vor.', ...kand, '',
      `Hier wählst Du drei aus, ergänzt Deine Einschätzung und sendest das PDF: ${appUrl()}/#schnelltest-${a.id}`, '',
      'RhetorIQ'
    ].join('\n')
  };
}

// Begleitmail an die Firma, Standardtext (Lorena kann ihn vor dem Senden ändern)
function begleitMail(host) {
  return {
    betreff: `Ihr Test «Wie klingt Ihre Firma?» für ${host}`,
    text: [
      'Guten Tag', '',
      `vielen Dank für Ihr Interesse am Test «Wie klingt Ihre Firma?». Ich habe mir die Texte auf ${host} in Ruhe angesehen und drei Auffälligkeiten ausgewählt, die mir besonders aufgefallen sind.`, '',
      'Im Anhang finden Sie die Auswertung als PDF. Zu jeder Auffälligkeit zeige ich Ihnen, was ich gelesen habe, warum es so wirkt und wie es sich anders sagen liesse.', '',
      'Wenn Sie darüber sprechen möchten, melden Sie sich gern direkt bei mir. Ich freue mich auf Ihre Rückmeldung.', '',
      'Herzlich', 'Lorena Lienhard'
    ].join('\n')
  };
}


// Sofortige Mail an die Person mit den drei Befunden, die auch auf dem Bildschirm stehen (Sie, in Lorenas Namen)
function ergebnisMail(host, befunde) {
  return {
    subject: `Ihr Test «Wie klingt Ihre Firma?» für ${host}`,
    text: [
      'Guten Tag', '',
      `Danke, dass Sie den Test «Wie klingt Ihre Firma?» für ${host} gemacht haben. Hier sind Ihre drei Befunde zur Sprache Ihrer Webseite:`, '',
      ...befunde.map((b, i) => `${i + 1}. ${b}`), '',
      `Wenn Sie die Befunde im Gespräch vertiefen möchten, wählen Sie hier ein Zeitfenster mit mir. Wir haben dafür zwanzig Minuten.`,
      `${appUrl()}/termin`, '',
      'Bei Fragen antworten Sie einfach auf diese Mail. Sie landet direkt bei mir.', '',
      'Herzlich', 'Lorena Lienhard'
    ].join('\n')
  };
}

module.exports = { hinweisMail, begleitMail, kennzahlenZeilen, ergebnisMail };
