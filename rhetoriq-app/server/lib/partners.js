// Empfehlungsprogramm: Partner (Treuhand, PR-Agenturen, Verbände) erhalten 10 Prozent der Monatsgebühr
// der von ihnen vermittelten Klienten, in den ersten 12 Monaten ab Anlegen des Klienten.
const crypto = require('crypto');
const { pool } = require('../db');
const { ensureSchema } = require('./schemaRedesign');
const { planPriceChf } = require('./costAlerts');

const RATE = 0.10;
const MONTHS = 12;

function cleanCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24); }

function makeCode(name) {
  const base = cleanCode(String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')).slice(0, 8) || 'PARTNER';
  return base + crypto.randomBytes(2).toString('hex').toUpperCase();
}

async function list() {
  await ensureSchema();
  const { rows } = await pool.query(`SELECT id, name, kontakt_email, code, aktiv FROM partner ORDER BY name`);
  const { rows: cl } = await pool.query(`SELECT partner_id FROM clients WHERE partner_id IS NOT NULL`);
  const n = {};
  cl.forEach(c => { n[c.partner_id] = (n[c.partner_id] || 0) + 1; });
  return rows.map(r => ({ ...r, clients: n[r.id] || 0 }));
}

async function create({ name, kontaktEmail, code }) {
  await ensureSchema();
  const nm = String(name || '').trim().slice(0, 160);
  if (!nm) throw new Error('Name fehlt.');
  const mail = String(kontaktEmail || '').trim().slice(0, 200);
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) throw new Error('Ungültige E-Mail-Adresse.');
  const c = cleanCode(code) || makeCode(nm);
  const dup = await pool.query(`SELECT id FROM partner WHERE code=$1`, [c]);
  if (dup.rows.length) throw new Error('Dieser Code ist schon vergeben.');
  const { rows } = await pool.query(`INSERT INTO partner (name, kontakt_email, code, aktiv) VALUES ($1,$2,$3,TRUE) RETURNING id, name, kontakt_email, code, aktiv`, [nm, mail || null, c]);
  return rows[0];
}

async function setActive(id, aktiv) {
  await ensureSchema();
  const { rows } = await pool.query(`UPDATE partner SET aktiv=$1 WHERE id=$2 RETURNING id, name, kontakt_email, code, aktiv`, [!!aktiv, id]);
  return rows[0] || null;
}

// Gültigen, aktiven Partner zu einem Code finden
async function byCode(code) {
  await ensureSchema();
  const c = cleanCode(code);
  if (!c) return null;
  const { rows } = await pool.query(`SELECT id, name FROM partner WHERE code=$1 AND aktiv=TRUE`, [c]);
  return rows[0] || null;
}

// Ganze Monate zwischen zwei Monaten (0 = gleicher Monat)
function monthDiff(from, to) { return (to.y - from.y) * 12 + (to.m - from.m); }

// Provision eines Partners für einen Monat 'YYYY-MM'. Zählt Klienten mit aktivem Abo, deren Anlegen
// höchstens 11 Monate vor dem Monat liegt (Anlegemonat = Monat 1, insgesamt 12 Monate).
async function provision(partnerId, month) {
  await ensureSchema();
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '')) || (() => { const d = new Date(); return [null, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0')]; })();
  const target = { y: Number(m[1]), m: Number(m[2]) };
  const label = `${m[1]}-${m[2]}`;
  const { rows: p } = await pool.query(`SELECT id, name, code FROM partner WHERE id=$1`, [partnerId]);
  if (!p[0]) return null;
  const { rows: cl } = await pool.query(
    `SELECT id, name, created_at, monthly_token_limit, subscription_status FROM clients WHERE partner_id=$1 ORDER BY created_at`, [partnerId]);
  const lines = [];
  for (const c of cl) {
    const cd = new Date(c.created_at);
    const k = monthDiff({ y: cd.getUTCFullYear(), m: cd.getUTCMonth() + 1 }, target);
    if (k < 0 || k >= MONTHS) continue;
    if (c.subscription_status !== 'active') continue;
    const price = planPriceChf(c.monthly_token_limit);
    if (price == null) continue;
    lines.push({ clientId: c.id, client: c.name, monatNr: k + 1, aboChf: price, provisionChf: Math.round(price * RATE * 100) / 100 });
  }
  const total = Math.round(lines.reduce((s, l) => s + l.provisionChf, 0) * 100) / 100;
  return { partner: p[0], month: label, ratePercent: RATE * 100, lines, totalChf: total };
}

function toCsv(r) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const out = ['Partner;Monat;Klient;Monat der Vermittlung (1 bis 12);Monatsabo CHF;Provision CHF'];
  r.lines.forEach(l => out.push([q(r.partner.name), r.month, q(l.client), l.monatNr, l.aboChf.toFixed(2), l.provisionChf.toFixed(2)].join(';')));
  out.push(`Total;;;;;${r.totalChf.toFixed(2)}`);
  return '﻿' + out.join('\r\n');
}

module.exports = { list, create, setActive, byCode, provision, toCsv, cleanCode, RATE, MONTHS };
