const express = require('express');
const { validPassword, PASSWORD_HINT } = require('../lib/passwordPolicy');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireAdvisor, requireAuth } = require('../middleware/auth');
const { brevoSend: brevoSendShared } = require('../lib/brevo');

const brevoSend = (opts) => brevoSendShared({ senderName: 'Lorena Lienhard', ...opts });

const { ensureSchema } = require('../lib/schemaRedesign');
const { TEXTARTEN } = require('../lib/moduleAccess');
const { guessClientType, guessLastName, createClientRecord } = require('../lib/clientCreate');

// Generate a secure 48-hour setup link and send it instead of a plaintext password.
// The client clicks the link, sets their own password — no credentials ever in email.
async function sendWelcomeEmail({ clientType, salutation, lastName, companyName, email, clientId, lang }) {
  if (!email) return;

  // Create onboarding token (48 h TTL)
  const setupToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO onboarding_tokens (client_id, token) VALUES ($1, $2)',
    [clientId, setupToken]
  );

  const BASE = process.env.APP_URL || 'https://rhetoriq.ch';
  const setupLink = `${BASE}/setup?t=${setupToken}`;

  const isDE = lang === 'de';
  const isCompany = clientType === 'company';
  // FLAGA gets a warmer, personally-addressed welcome email instead of the
  // generic "Sehr geehrte Damen und Herren" company template — requested
  // specifically for this client, every other client keeps the default below.
  const isFlaga = /flaga/i.test(companyName || '');

  const salutationLine = isFlaga
    ? 'Liebe Familie Matteo, sehr geehrtes Team von FLAGA'
    : isDE
    ? (isCompany
        ? `Sehr geehrte Damen und Herren von ${companyName},`
        : `Sehr geehrte${salutation === 'Herr' ? 'r Herr' : ' Frau'} ${lastName},`)
    : (isCompany
        ? `Dear team of ${companyName},`
        : `Dear ${salutation} ${lastName},`);

  const subject = isDE
    ? 'Willkommen bei RhetorIQ – Ihren Zugang einrichten'
    : 'Welcome to RhetorIQ – Set up your access';

  const body = isFlaga
    ? `${salutationLine}\n\nwillkommen bei RhetorIQ. Als Verkaufsstelle im FLAGA-Netz schreiben Sie jeden Tag Kundenanfragen, Angebote und Nachrichten, die nach Ihnen klingen sollen, nicht nach einer Vorlage von der Stange. Genau dafür haben wir RhetorIQ für Sie eingerichtet.\n\nBitte richten Sie Ihren persönlichen Zugang über den folgenden Link ein:\n\n${setupLink}\n\nDieser Link ist 48 Stunden gültig. Sie werden dort aufgefordert, ein eigenes Passwort zu wählen. Danach ist Ihr Zugang vollständig personalisiert und gesichert.\n\nE-Mail: ${email}\nPlattform: https://rhetoriq.ch\n\nBei Fragen zur Einrichtung melden Sie sich direkt bei mir, ich begleite Sie in den ersten Wochen persönlich.\n\nFreundliche Grüsse\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`
    : isDE
    ? `${salutationLine}\n\nes freut mich, Sie bei RhetorIQ willkommen zu heissen.\n\nRhetorIQ gibt Ihnen präzise Werkzeuge für Ihre Führungskommunikation – zugeschnitten auf Ihre Stimme und Ihre Ziele.\n\nBitte richten Sie Ihren persönlichen Zugang über den folgenden Link ein:\n\n${setupLink}\n\nDieser Link ist 48 Stunden gültig. Sie werden dort aufgefordert, ein eigenes Passwort zu wählen. Danach ist Ihr Zugang vollständig personalisiert und gesichert.\n\nE-Mail: ${email}\nPlattform: https://rhetoriq.ch\n\nIch freue mich darauf, gemeinsam mit Ihnen zu arbeiten.\n\nHerzlich,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`
    : `${salutationLine}\n\nIt is a pleasure to welcome you to RhetorIQ.\n\nRhetorIQ gives you precise tools for your leadership communication – tailored to your voice and your goals.\n\nPlease set up your personal access using the link below:\n\n${setupLink}\n\nThis link is valid for 48 hours. You will be prompted to choose your own password. After that, your access is fully personalised and secured.\n\nEmail: ${email}\nPlatform: https://rhetoriq.ch\n\nI look forward to working with you.\n\nWarm regards,\nLorena Lienhard\nRhetoric & Executive Communication Coaching\ncontact@lorenalienhard.ch · +41 79 957 39 76 · lorenalienhard.ch`;

  await brevoSend({ to: email, subject, text: body });
  console.log(`Welcome email (setup link) sent to ${email}`);
}

async function sendTokenEmail(clientName, token) {
  const to = process.env.ADVISOR_EMAIL;
  if (!to) return;
  await brevoSend({
    to,
    subject: `RhetorIQ — Neuer Klient: ${clientName}`,
    text: `Neuer Klient wurde angelegt:\n\nName: ${clientName}\nToken: ${token}\n\nTeilen Sie diesen Token mit Ihrem Klienten — damit kann er sich in der App einloggen.\n\nhttps://rhetoriq.ch`
  });
}

const router = express.Router();

// GET /api/clients
router.get('/', requireAdvisor, async (req, res) => {
  try {
    await ensureClientAddressColumn();
    await ensureSchema();
    const { rows } = await pool.query(
      'SELECT id, name, industry, contact, slug, token, capital_markets_enabled, hotel_enabled, enabled_modules, enabled_textarten, address, created_at, email, client_type, salutation, last_name, nur_beratung, arbeitssprache FROM clients WHERE advisor_id = $1 AND geloescht_am IS NULL ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients
router.post('/', requireAdvisor, async (req, res) => {
  try {
    const { name, industry, contact, email, initialPassword, clientType, salutation, lastName, emailLang, privacyAcknowledged, sector, enabled_modules, nurBeratung, arbeitssprache } = req.body;
    if (!name || name.length > 200) return res.status(400).json({ error: 'Name required (max 200 chars)' });
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (industry && industry.length > 200) return res.status(400).json({ error: 'Industry max 200 chars' });
    if (contact && contact.length > 500) return res.status(400).json({ error: 'Contact max 500 chars' });
    if (!privacyAcknowledged) return res.status(400).json({ error: 'Datenschutz-Bestätigung erforderlich' });
    if (nurBeratung === true || arbeitssprache === 'en') await ensureSchema();

    const { row: client, resolvedType, resolvedLastName } = await createClientRecord({
      advisorId: req.user.id, name, industry, contact, email, clientType, salutation, lastName, enabledModules: enabled_modules, nurBeratung: nurBeratung === true, arbeitssprache: arbeitssprache === 'en' ? 'en' : 'de'
    });
    const rows = [client];

    if (nurBeratung === true) {
      // Nur Beratung: keine Mail an den Klienten und keine Zugangsmail. Der Zugang lässt sich später freischalten.
    } else if (email) {
      // Send secure setup link — no password in email
      sendWelcomeEmail({
        clientType: resolvedType,
        salutation: salutation || 'Frau',
        lastName: resolvedLastName,
        companyName: name,
        email,
        clientId: rows[0].id,
        lang: emailLang || (arbeitssprache === 'en' ? 'en' : 'de')
      }).catch(e => console.error('Welcome email error:', e.message));
    } else {
      sendTokenEmail(name, client.token).catch(e => console.error('Token email error:', e.message));
    }

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clients/export — CSV for Excel
router.get('/export', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name, industry, contact, token, created_at FROM clients WHERE advisor_id = $1 AND geloescht_am IS NULL ORDER BY created_at DESC',
      [req.user.id]
    );
    const esc = require('../lib/csvSafe').csvCell;
    const csv = [
      ['Name', 'Industry', 'Contact', 'Token', 'Created'].map(esc).join(','),
      ...rows.map(r => [r.name, r.industry, r.contact, r.token, new Date(r.created_at).toLocaleDateString('de-CH')].map(esc).join(','))
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rhetoriq-clients.csv"');
    res.send('﻿' + csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/send-token
router.post('/:id/send-token', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    const client = rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const to = req.body.email || client.email;
    if (!to) return res.status(400).json({ error: 'No email address available' });

    await brevoSend({
      to,
      subject: 'RhetorIQ – Ihr persönlicher Zugangscode / Your personal access token',
      text: `Access Token für ${client.name} / Access token for ${client.name}:\n\n${client.token}\n\nPlattform / Platform: https://rhetoriq.ch/login\n\n--\nLorena Lienhard\ncontact@lorenalienhard.ch`
    });

    res.json({ ok: true, sentTo: to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/send-welcome — (re)send the password-setup welcome
// email for a client that was created earlier without triggering it yet.
router.post('/:id/send-welcome', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE id = $1 AND advisor_id = $2',
      [req.params.id, req.user.id]
    );
    const client = rows[0];
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const email = req.body.email || client.email;
    if (!email) return res.status(400).json({ error: 'No email address available' });

    if (email !== client.email) {
      await pool.query('UPDATE clients SET email=$1, must_change_password=true WHERE id=$2', [email, client.id]);
    }

    // Prefer what's actually stored on the client (set at creation, or
    // corrected since) over a request body that usually doesn't send this
    // at all for a simple resend — falling back to 'company' unconditionally
    // here is exactly what mis-addressed individual clients like "Joanne
    // Sieber" as "Sehr geehrte Damen und Herren von Joanne Sieber". For
    // clients created before client_type existed, guess from the name.
    const resolvedType = req.body.clientType || client.client_type || guessClientType(client.name);
    const resolvedLastName = req.body.lastName || client.last_name || (resolvedType === 'individual' ? guessLastName(client.name) : '');
    await sendWelcomeEmail({
      clientType: resolvedType,
      salutation: req.body.salutation || client.salutation || 'Frau',
      lastName: resolvedLastName,
      companyName: client.name,
      email,
      clientId: client.id,
      lang: req.body.lang || (client.arbeitssprache === 'en' ? 'en' : 'de')
    });

    res.json({ ok: true, sentTo: email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/set-password
router.post('/:id/set-password', requireAdvisor, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_HINT });
    const hash = await bcrypt.hash(password, 12);
    const updates = [hash, req.params.id, req.user.id];
    let q = 'UPDATE clients SET password_hash=$1, must_change_password=false, token_version=token_version+1';
    if (email) { q += ', email=$4'; updates.push(email); }
    q += ' WHERE id=$2 AND advisor_id=$3';
    await pool.query(q, updates);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// PUT /api/clients/:id/arbeitssprache  { sprache: 'de' | 'en' }
// Arbeitssprache des Klienten: 'en' schaltet British English im Corporate-Stil ein (Regelwerk, Prüfung, Brand-Voice-Analyse, Standardsprache der Texte).
router.put('/:id/arbeitssprache', requireAdvisor, async (req, res) => {
  try {
    const sprache = require('../lib/arbeitssprache').gueltig(req.body && req.body.sprache);
    if (!sprache) return res.status(400).json({ error: "sprache muss 'de' oder 'en' sein" });
    await ensureSchema();
    const { rows } = await pool.query(
      'UPDATE clients SET arbeitssprache=$1 WHERE id=$2 AND advisor_id=$3 AND geloescht_am IS NULL RETURNING id, arbeitssprache',
      [sprache, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, arbeitssprache: rows[0].arbeitssprache });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients/:id/zugang-freischalten — macht aus einem Beratungsklienten einen normalen Klienten.
// Mit { sendWelcome: true } und hinterlegter E-Mail-Adresse geht zusätzlich die Willkommens-E-Mail raus.
router.post('/:id/zugang-freischalten', requireAdvisor, async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      'UPDATE clients SET nur_beratung=FALSE, must_change_password=(email IS NOT NULL) WHERE id=$1 AND advisor_id=$2 AND geloescht_am IS NULL RETURNING id, name, email, client_type, salutation, last_name',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    const c = rows[0];
    let willkommen = false;
    if (req.body && req.body.sendWelcome === true && c.email) {
      sendWelcomeEmail({ clientType: c.client_type || 'company', salutation: c.salutation || 'Frau', lastName: c.last_name || '', companyName: c.name, email: c.email, clientId: c.id, lang: (req.body.emailLang || 'de') })
        .catch(e => console.error('Welcome email error:', e.message));
      willkommen = true;
    }
    res.json({ ok: true, nur_beratung: false, willkommenGesendet: willkommen });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clients/:id/revoke-access — Zugang entziehen: beendet sofort alle Sitzungen des Klienten und seiner
// Teammitglieder UND erzeugt einen neuen Zugangscode (der alte Code funktioniert nicht mehr). Mit
// { resetPassword: true } wird zusätzlich das Passwort des Hauptzugangs gelöscht.
router.post('/:id/revoke-access', requireAdvisor, async (req, res) => {
  try {
    const r = await require('../lib/accessControl').revokeClientAccess(req.params.id, req.user.id, { resetPassword: !!(req.body && req.body.resetPassword) });
    if (!r) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, token: r.token, message: 'Der Zugang wurde entzogen. Alle Sitzungen sind beendet, der alte Zugangscode ist ungültig.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/clients/:id/logout-all-devices — alle Geräte des Klienten und seiner Teammitglieder abmelden (Zugangscode bleibt)
router.post('/:id/logout-all-devices', requireAdvisor, async (req, res) => {
  try {
    const r = await require('../lib/accessControl').logoutClientDevices(req.params.id, req.user.id);
    if (!r) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, message: 'Alle Geräte sind abgemeldet.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/users — list team members
router.get('/:id/users', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      'SELECT id, email, name, role, created_at FROM client_users WHERE client_id=$1 ORDER BY created_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/clients/:id/user-limit — Nutzerlimit des Pakets, belegte Plätze, Zusatznutzer
router.get('/:id/user-limit', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(await require('../lib/userLimit').status(req.params.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PUT /api/clients/:id/extra-users  { extra_users: 0..50 } — gebuchte Zusatznutzer (CHF 49 pro Monat und Person)
router.put('/:id/extra-users', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const n = Math.round(Number(req.body.extra_users));
    if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: 'Zusatznutzer müssen zwischen 0 und 50 liegen.' });
    await require('../lib/schemaRedesign').ensureSchema();
    // Im Paket Stimme ist genau eine Person enthalten: Zusatznutzer gibt es erst ab Team
    if (n > 0) {
      const st0 = await require('../lib/userLimit').status(req.params.id);
      if (st0 && st0.plan === 'stimme') return res.status(409).json({ error: 'Das Paket Stimme enthält eine Person. Für weitere Personen wechselt die Kundschaft auf das Paket Team.' });
    }
    await pool.query('UPDATE clients SET extra_users=$1 WHERE id=$2', [n, req.params.id]);
    res.json(await require('../lib/userLimit').status(req.params.id));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/clients/:id/users — add team member
router.post('/:id/users', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    const { email, name, password } = req.body;
    const role = req.body.role === undefined || req.body.role === '' ? 'editor' : req.body.role;
    if (!require('../lib/accessControl').TEAM_ROLES.includes(role)) return res.status(400).json({ error: 'Rolle muss admin, editor oder viewer sein.' });
    if (!email || !name || !password) return res.status(400).json({ error: 'Email, name and password required' });
    // Nutzerlimit je Paket (ein bereits vorhandenes Mitglied mit derselben E-Mail zählt nicht neu)
    const ul = require('../lib/userLimit');
    const st = await ul.status(req.params.id);
    const { rows: ex } = await pool.query('SELECT 1 FROM client_users WHERE client_id=$1 AND email=$2', [req.params.id, String(email).toLowerCase()]);
    if (st && st.full && !ex.length && st.plan === 'stimme') {
      return res.status(409).json({ error: 'Das Paket Stimme enthält eine Person. Für weitere Personen wechselt die Kundschaft auf das Paket Team.' });
    }
    if (st && st.full && !ex.length) {
      return res.status(409).json({ error: `Das Paket ${st.planName} enthält ${st.limit} ${st.limit === 1 ? 'Nutzer' : 'Nutzer'} (Hauptzugang inklusive). Weitere Personen sind als Zusatznutzer für CHF 49 pro Monat möglich: Zusatznutzer erhöhen oder das Paket wechseln.`, limit: st.limit, used: st.used });
    }
    if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_HINT });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO client_users (client_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, email) DO UPDATE SET name=$3, password_hash=$4, role=$5, token_version=client_users.token_version+1 RETURNING id, email, name, role, created_at',
      [req.params.id, email.toLowerCase(), name, hash, role]
    );

    // Also add them to the People directory (Voice DNA etc.) if not already
    // there, so a new team member is immediately available for per-person
    // features like Speaker Voice DNA — skip if a person with this name
    // already exists for this client to avoid duplicates.
    const { rows: existingPeople } = await pool.query(
      'SELECT id FROM people WHERE client_id=$1 AND LOWER(name)=LOWER($2)',
      [req.params.id, name]
    );
    if (!existingPeople.length) {
      await pool.query('INSERT INTO people (client_id, name) VALUES ($1,$2)', [req.params.id, name]);
    }

    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/clients/:clientId/users/:userId — remove team member
router.delete('/:id/users/:userId', requireAdvisor, async (req, res) => {
  try {
    const { rows: clientRows } = await pool.query('SELECT id FROM clients WHERE id=$1 AND advisor_id=$2', [req.params.id, req.user.id]);
    if (!clientRows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('DELETE FROM client_users WHERE id=$1 AND client_id=$2', [req.params.userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/clients/:id
// PUT /api/clients/:id/capital-markets-toggle
// PUT /api/clients/:id/address — the client's own sender address, used to
// auto-fill "Sender (Absender)" when generating a formal Brief for this client.
let clientAddressColumnEnsured = false;
async function ensureClientAddressColumn() {
  if (clientAddressColumnEnsured) return;
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT`);
  clientAddressColumnEnsured = true;
}
router.put('/:id/address', requireAdvisor, async (req, res) => {
  try {
    await ensureClientAddressColumn();
    const { address } = req.body;
    const { rows } = await pool.query(
      'UPDATE clients SET address=$1 WHERE id=$2 AND advisor_id=$3 RETURNING address',
      [address || '', req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ address: rows[0].address });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/capital-markets-toggle', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET capital_markets_enabled = NOT capital_markets_enabled WHERE id = $1 AND advisor_id = $2 RETURNING capital_markets_enabled',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ capital_markets_enabled: rows[0].capital_markets_enabled });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/cm-status — accessible by client token too
router.get('/:id/cm-status', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'client' && req.user.clientId != req.params.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'advisor') {
      const { rows: ownerCheck } = await pool.query(
        'SELECT id FROM clients WHERE id=$1 AND advisor_id=$2',
        [req.params.id, req.user.id]
      );
      if (!ownerCheck[0]) return res.status(403).json({ error: 'Forbidden' });
    }
    await ensureSchema();
    const { rows } = await pool.query(
      'SELECT capital_markets_enabled, hotel_enabled, enabled_modules, enabled_textarten, arbeitssprache FROM clients WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({
      capital_markets_enabled: rows[0].capital_markets_enabled,
      hotel_enabled: rows[0].hotel_enabled,
      enabled_modules: rows[0].enabled_modules || null,
      enabled_textarten: rows[0].enabled_textarten || null,
      arbeitssprache: rows[0].arbeitssprache === 'en' ? 'en' : 'de'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/modules-config  { modules: [...], textarten?: [...] | null }
// textarten: Liste der erlaubten Textarten des Text Generators; null = alle; fehlt das Feld, bleibt der Stand unverändert.
router.put('/:id/modules-config', requireAdvisor, async (req, res) => {
  try {
    const { modules } = req.body;
    if (!Array.isArray(modules)) return res.status(400).json({ error: 'modules must be an array' });
    const hasArten = Object.prototype.hasOwnProperty.call(req.body, 'textarten');
    let arten = null;
    if (hasArten && req.body.textarten !== null) {
      if (!Array.isArray(req.body.textarten)) return res.status(400).json({ error: 'textarten muss eine Liste oder null sein.' });
      const bad = req.body.textarten.find(t => !TEXTARTEN.includes(t));
      if (bad !== undefined) return res.status(400).json({ error: 'Unbekannte Textart: ' + String(bad).slice(0, 40) });
      arten = [...new Set(req.body.textarten)];
    }
    await ensureSchema();
    const { rows } = hasArten
      ? await pool.query('UPDATE clients SET enabled_modules = $1, enabled_textarten = $4 WHERE id = $2 AND advisor_id = $3 RETURNING enabled_modules, enabled_textarten', [modules, req.params.id, req.user.id, arten])
      : await pool.query('UPDATE clients SET enabled_modules = $1 WHERE id = $2 AND advisor_id = $3 RETURNING enabled_modules, enabled_textarten', [modules, req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ enabled_modules: rows[0].enabled_modules, enabled_textarten: rows[0].enabled_textarten || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/hotel-toggle
router.put('/:id/hotel-toggle', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE clients SET hotel_enabled = NOT hotel_enabled WHERE id = $1 AND advisor_id = $2 RETURNING hotel_enabled',
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ hotel_enabled: rows[0].hotel_enabled });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/token-limit — set or clear this client's monthly
// token quota (tie the value to their subscription tier). null/0 = unlimited.
router.put('/:id/token-limit', requireAdvisor, async (req, res) => {
  try {
    const { monthlyTokenLimit } = req.body;
    const limit = (monthlyTokenLimit === null || monthlyTokenLimit === undefined || monthlyTokenLimit === '')
      ? null
      : parseInt(monthlyTokenLimit, 10);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
      return res.status(400).json({ error: 'monthlyTokenLimit must be a positive number or null' });
    }
    const { rows } = await pool.query(
      'UPDATE clients SET monthly_token_limit = $1 WHERE id = $2 AND advisor_id = $3 RETURNING monthly_token_limit',
      [limit, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ monthlyTokenLimit: rows[0].monthly_token_limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/gratis-test: Schalter und Stand des Gratis-Tests (nur Beraterin)
router.get('/:id/gratis-test', requireAdvisor, async (req, res) => {
  try {
    const abo = require('../lib/abo');
    const { rows } = await pool.query('SELECT id FROM clients WHERE id = $1 AND advisor_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    const row = await abo.clientRow(rows[0].id);
    const st = await abo.teststand(row);
    res.json({ an: row.gratis_test === true, gratisZugang: row.gratis_zugang === true, status: row.subscription_status || 'trial', tage: abo.TEST_TAGE, texte: abo.TEST_TEXTE, ...st });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/gratis-test { an: true|false }: die Beraterin entscheidet je Klient zwischen Gratis-Test und direktem Abo.
// Einschalten startet den Test neu (beginnt beim nächsten Login), Ausschalten verlangt sofort ein Abo.
router.put('/:id/gratis-test', requireAdvisor, async (req, res) => {
  try {
    const an = req.body && (req.body.an === true || req.body.an === 'true');
    // zuruecksetzen: Abo-Status wieder auf «Test» stellen (nur wenn der Klient nicht über Stripe zahlt)
    const reset = an && req.body && req.body.zuruecksetzen === true;
    await require('../lib/schemaRedesign').ensureSchema();
    // Gratis-Zugang: bewusst ohne Abo (Partner, Sonderfälle), schliesst Gratis-Test und Rechnungsfrist aus
    if (req.body && typeof req.body.gratisZugang === 'boolean') {
      const g = await pool.query('UPDATE clients SET gratis_zugang=$1 WHERE id=$2 AND advisor_id=$3 RETURNING id', [req.body.gratisZugang, req.params.id, req.user.id]);
      if (!g.rows[0]) return res.status(404).json({ error: 'Client not found' });
      if (req.body.gratisZugang) return res.json({ an: false, gratisZugang: true });
    }
    await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT');
    const { rows } = await pool.query(
      `UPDATE clients SET gratis_test = $1::boolean, trial_start = CASE WHEN $1::boolean THEN NULL ELSE trial_start END,
         subscription_status = CASE WHEN $4::boolean THEN 'trial' ELSE subscription_status END,
         zugang_bis = CASE WHEN $4::boolean THEN NULL ELSE zugang_bis END
       WHERE id = $2 AND advisor_id = $3 AND ($4::boolean = false OR stripe_customer_id IS NULL) RETURNING id`,
      [an, req.params.id, req.user.id, reset]
    );
    if (!rows[0]) {
      const { rows: da } = await pool.query('SELECT id FROM clients WHERE id = $1 AND advisor_id = $2', [req.params.id, req.user.id]);
      if (da[0] && reset) return res.status(409).json({ error: 'Dieser Klient hat ein Stripe-Abo. Bitte zuerst im Kundenportal oder in Stripe kündigen.' });
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ an });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/clients/:id/aufbewahrung — wie lange Eingaben und Ergebnisse gespeichert bleiben (Tage, leer = unbegrenzt).
// Danach leert der tägliche Löschlauf (lib/retention.js) die Inhalte; Zähler, Bewertungen und Daten bleiben.
router.put('/:id/aufbewahrung', requireAdvisor, async (req, res) => {
  try {
    const roh = req.body && req.body.tage;
    const tage = (roh === null || roh === undefined || roh === '') ? null : parseInt(roh, 10);
    if (tage !== null && (!Number.isFinite(tage) || tage < 7 || tage > 3650)) {
      return res.status(400).json({ error: 'Die Frist muss zwischen 7 und 3650 Tagen liegen.' });
    }
    const { rows } = await pool.query(
      'UPDATE clients SET aufbewahrung_tage = $1 WHERE id = $2 AND advisor_id = $3 RETURNING aufbewahrung_tage',
      [tage, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ tage: rows[0].aufbewahrung_tage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/aufbewahrung
router.get('/:id/aufbewahrung', requireAdvisor, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT aufbewahrung_tage FROM clients WHERE id = $1 AND advisor_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Client not found' });
    res.json({ tage: rows[0].aufbewahrung_tage });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/clients/:id/token-usage — current-month usage vs. quota, for
// both the advisor dashboard and the client's own "usage" view.
router.get('/:id/token-usage', requireAuth, async (req, res) => {
  try {
    const clientId = req.params.id;
    if (req.user.role === 'client' && String(req.user.clientId) !== String(clientId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { rows: cRows } = await pool.query(
      'SELECT monthly_token_limit FROM clients WHERE id = $1' + (req.user.role === 'advisor' ? ' AND advisor_id = $2' : ''),
      req.user.role === 'advisor' ? [clientId, req.user.id] : [clientId]
    );
    if (!cRows[0]) return res.status(404).json({ error: 'Client not found' });
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS used
       FROM usage_log WHERE client_id=$1 AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
      [clientId]
    );
    res.json({ used: Number(rows[0].used), limit: cRows[0].monthly_token_limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/clients/:id — Klient in den Papierkorb legen (clients.geloescht_am, siehe lib/papierkorb.js). Nach 30 Tagen
// löscht ein Job endgültig. Mit &endgueltig=ja wird sofort vollständig gelöscht (alle Tabellen, eine Transaktion,
// siehe lib/clientData.js), zum Beispiel auf Wunsch der betroffenen Person.
// Die Rückfrage im Frontend ist Pflicht; der Server verlangt zusätzlich ?confirm=ja.
router.delete('/:id', requireAdvisor, async (req, res) => {
  try {
    if (req.query.confirm !== 'ja') return res.status(400).json({ error: 'Löschen bitte mit Bestätigung (confirm=ja) aufrufen.' });
    if (req.query.endgueltig !== 'ja') {
      const k = await require('../lib/papierkorb').inPapierkorb(parseInt(req.params.id, 10), req.user.id);
      if (!k) return res.status(404).json({ error: 'Client not found (or belongs to a different advisor account)' });
      return res.json({ ok: true, papierkorb: true, tage: require('../lib/papierkorb').FRIST_TAGE });
    }
    const r = await require('../lib/clientData').deleteClientCompletely(parseInt(req.params.id, 10), req.user.id);
    if (!r) return res.status(404).json({ error: 'Client not found (or belongs to a different advisor account)' });
    res.json({ ok: true, deleted: r.counts });
  } catch (e) {
    console.error('[clients] delete failed:', e.message);
    res.status(500).json({ error: 'Das Löschen hat nicht geklappt. Es wurde nichts verändert.' });
  }
});

// GET /api/clients/:id/export-data — alle Daten des Klienten als ZIP (JSON je Tabelle, Dateien, Word mit den Texten)
router.get('/:id/export-data', requireAdvisor, async (req, res) => {
  try {
    const r = await require('../lib/clientData').exportClientData(parseInt(req.params.id, 10), req.user.id);
    if (!r) return res.status(404).json({ error: 'Client not found' });
    const safe = String(r.name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'Klient';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Datenauszug_${safe}.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(r.buffer);
  } catch (e) {
    console.error('[clients] export failed:', e.message);
    res.status(500).json({ error: 'Der Datenauszug hat nicht geklappt.' });
  }
});

module.exports = router;
