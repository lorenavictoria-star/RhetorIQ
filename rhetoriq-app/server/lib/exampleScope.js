// Strikte Trennung der Klienten bei Strukturvorlagen (module_examples).
// Eine Vorlage gilt klientenübergreifend nur, wenn is_cross_client_shareable wahr ist. Sonst steht sie nur dem
// Klienten zur Verfügung, aus dessen Texten sie stammt (source_client_id). Vorlagen der Beraterin ohne Klientenbezug
// (zum Beispiel die Schulungsvorlagen) sind freigegeben angelegt und gelten für alle ihre Klienten.
// n: Nummer des SQL-Parameters mit der Klienten-ID (darf NULL sein, dann zählen nur freigegebene Vorlagen).
function scopeSql(n) {
  return `(is_cross_client_shareable IS TRUE OR source_client_id = $${n}::int)`;
}
module.exports = { scopeSql };
