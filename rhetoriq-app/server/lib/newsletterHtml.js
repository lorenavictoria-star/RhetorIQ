// Newsletter-Text in sauberes, mailtaugliches HTML umwandeln (für Klaviyo-Vorlagen).
// Einfache Tabellenstruktur mit Inline-Stilen, keine Skripte, keine Fremdinhalte. Aller Text wird maskiert.
// Auch die geschweiften Klammern werden maskiert, damit im Text keine Klaviyo-Vorlagenbefehle ({{ }} oder {% %}) wirken können.

const BETREFF = /^\s*(?:\*\*)?(?:BETREFF(?:ZEILE)?|Betreff(?:zeile)?|Subject(?: line)?)(?:\*\*)?\s*:\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/i;
const VORSCHAU = /^\s*(?:\*\*)?(?:VORSCHAU(?:TEXT)?|Vorschau(?:text)?|Preview(?: text)?|Preheader)(?:\*\*)?\s*:\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/i;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

// Zerlegt den Text in Betreff, Vorschau und Rumpf
function zerlege(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let betreff = '', vorschau = '';
  const rest = [];
  for (const l of lines) {
    if (!betreff && BETREFF.test(l)) { betreff = l.match(BETREFF)[1].trim(); continue; }
    if (!vorschau && VORSCHAU.test(l)) { vorschau = l.match(VORSCHAU)[1].trim(); continue; }
    rest.push(l);
  }
  return { betreff, vorschau, body: rest.join('\n').trim() };
}

// Inline-Auszeichnung: **fett**. Alles andere bleibt Text. Der Aufruf bekommt schon maskierten Text.
function inline(escaped) {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

const P = 'margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#1a1a1a;';
const H = 'margin:24px 0 10px 0;font-size:20px;line-height:1.3;font-weight:bold;color:#1a1a1a;';
const LI = 'margin:0 0 6px 0;font-size:16px;line-height:1.6;color:#1a1a1a;';

function istListe(l) { return /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l); }
function listeninhalt(l) { return l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''); }

// Rumpf in Blöcke: Überschrift (#, ## oder eine Zeile nur aus **fett**), Liste, Absatz
function bloecke(body) {
  const out = [];
  const paras = String(body || '').split(/\n\s*\n/);
  for (const raw of paras) {
    const lines = raw.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
    if (!lines.length) continue;
    let i = 0;
    let buf = [];
    const flush = () => { if (buf.length) { out.push({ t: 'p', lines: buf }); buf = []; } };
    while (i < lines.length) {
      const l = lines[i];
      const h = l.match(/^\s*#{1,4}\s+(.+)$/) || l.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*$/);
      if (h) { flush(); out.push({ t: 'h', text: h[1].trim() }); i++; continue; }
      if (istListe(l)) {
        flush();
        const items = [];
        while (i < lines.length && istListe(lines[i])) { items.push(listeninhalt(lines[i])); i++; }
        out.push({ t: 'ul', items });
        continue;
      }
      buf.push(l); i++;
    }
    flush();
  }
  return out;
}

// Gibt { betreff, vorschau, html }. opts.name: Absendername für die Fusszeile (optional)
function baueHtml(text, opts = {}) {
  const z = zerlege(text);
  const inhalt = bloecke(z.body).map(b => {
    if (b.t === 'h') return `<h2 style="${H}">${inline(esc(b.text))}</h2>`;
    if (b.t === 'ul') return `<ul style="margin:0 0 16px 0;padding-left:22px;">${b.items.map(x => `<li style="${LI}">${inline(esc(x))}</li>`).join('')}</ul>`;
    return `<p style="${P}">${b.lines.map(l => inline(esc(l.trim()))).join('<br>')}</p>`;
  }).join('\n');
  const vorschauHtml = z.vorschau
    ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${esc(z.vorschau)}</div>`
    : '';
  const titel = esc(z.betreff || opts.name || 'Newsletter');
  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titel}</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
${vorschauHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;"><tr><td style="padding:32px;font-family:Arial,Helvetica,sans-serif;">
${inhalt}
</td></tr>
<tr><td style="padding:16px 32px 28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#666666;">
{% unsubscribe 'Abmelden' %}<br>{{ organization.full_address }}
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { betreff: z.betreff, vorschau: z.vorschau, html };
}

module.exports = { baueHtml, zerlege, bloecke, esc };
