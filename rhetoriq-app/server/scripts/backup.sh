#!/usr/bin/env bash
# Verschlüsselte Sicherung der RhetorIQ-Datenbank (pg_dump) in einen Zielordner.
#
# Aufruf:
#   backup.sh <Zielordner>                       Sicherung erstellen, verschlüsseln, alte Dateien entfernen
#   backup.sh --restore <Sicherung> [<Ziel>]     Sicherung in eine TESTDATENBANK einspielen (nie in die Produktion)
#
# Umgebungsvariablen (nur Namen, die Werte stehen nie in dieser Datei):
#   DATABASE_URL             Verbindung zur Produktionsdatenbank (nur lesend genutzt)
#   BACKUP_GPG_RECIPIENT     öffentlicher GPG-Schlüssel (Empfänger). Bevorzugt: Der private Schlüssel liegt nicht auf dem Server.
#   BACKUP_PASSPHRASE        Alternative ohne gpg: Passphrase für openssl (AES-256). Nur wenn BACKUP_GPG_RECIPIENT fehlt.
#   BACKUP_KEEP_DAILY        Tage, die tägliche Sicherungen aufbewahrt werden (Standard 30)
#   BACKUP_KEEP_MONTHLY      Tage, die Monatssicherungen (jeweils vom 1.) aufbewahrt werden (Standard 365)
#   BACKUP_PING_URL          optional: Adresse eines Überwachungsdienstes (zum Beispiel healthchecks.io). Bei Erfolg wird sie
#                            aufgerufen, bei Fehler wird /fail angehängt. So fällt eine stille Panne auf (der frühere Job
#                            schrieb nur auf eine flüchtige Festplatte und meldete trotzdem Erfolg).
#   RESTORE_DATABASE_URL     Testdatenbank für --restore (muss sich von DATABASE_URL unterscheiden)
#
# Hinweis: Der Zielordner sollte bei einem ZWEITEN Anbieter liegen (zum Beispiel eingebundener Objektspeicher in der
# Schweiz oder EU) oder anschliessend mit rclone dorthin kopiert werden. Siehe Backup_Anleitung.md.
set -euo pipefail

log() { printf '[backup] %s\n' "$*" >&2; }
ping_ok() { [ -n "${BACKUP_PING_URL:-}" ] && curl -fsS -m 15 --retry 2 "$BACKUP_PING_URL" >/dev/null 2>&1 || true; }
ping_fail() { [ -n "${BACKUP_PING_URL:-}" ] && curl -fsS -m 15 --retry 2 "${BACKUP_PING_URL%/}/fail" >/dev/null 2>&1 || true; }

encrypt() { # liest stdin, schreibt stdout
  if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
    gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT"
  elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE
  else
    log "Weder BACKUP_GPG_RECIPIENT noch BACKUP_PASSPHRASE gesetzt. Es wird nie unverschlüsselt gesichert."
    return 1
  fi
}

decrypt() { # liest stdin, schreibt stdout
  case "$1" in
    *.gpg) gpg --batch --decrypt ;;
    *.enc) openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE ;;
    *) log "Unbekannte Endung: $1"; return 1 ;;
  esac
}

restore() {
  local file="${1:-}"
  [ -f "$file" ] || { log "Sicherung nicht gefunden: $file"; exit 2; }
  local target="${RESTORE_DATABASE_URL:-${2:-}}"
  [ -n "$target" ] || { log "RESTORE_DATABASE_URL (Testdatenbank) fehlt."; exit 2; }
  if [ "$target" = "${DATABASE_URL:-}" ]; then log "Die Testdatenbank darf nicht die Produktionsdatenbank sein."; exit 2; fi
  local tmp; tmp="$(mktemp)"; trap "rm -f '$tmp'" EXIT
  decrypt "$file" < "$file" > "$tmp"
  pg_restore --no-owner --clean --if-exists -d "$target" "$tmp"
  log "Eingespielt in die Testdatenbank. Jetzt prüfen: Anzahl Klienten, Anzahl Texte, Stichprobe Brand Voice, Anmeldung."
}

if [ "${1:-}" = "--restore" ]; then shift; restore "$@"; exit 0; fi

DEST="${1:-}"
[ -n "$DEST" ] || { log "Aufruf: backup.sh <Zielordner>"; exit 2; }
[ -n "${DATABASE_URL:-}" ] || { log "DATABASE_URL fehlt."; ping_fail; exit 2; }

trap 'ping_fail; log "FEHLGESCHLAGEN"' ERR
mkdir -p "$DEST/daily" "$DEST/monthly"
STAMP="$(date +%F)"
EXT="enc"; [ -n "${BACKUP_GPG_RECIPIENT:-}" ] && EXT="gpg"
OUT="$DEST/daily/rhetoriq-$STAMP.dump.$EXT"
TMP="$OUT.part"

log "Sicherung nach $OUT"
pg_dump --format=custom --no-owner --dbname "$DATABASE_URL" | encrypt > "$TMP"
# Eine leere oder winzige Datei ist ein Fehler, auch wenn kein Befehl gescheitert ist
SIZE="$(wc -c < "$TMP" | tr -d ' ')"
if [ "$SIZE" -lt 1024 ]; then log "Sicherung auffällig klein ($SIZE Byte)"; rm -f "$TMP"; false; fi
mv "$TMP" "$OUT"
log "Fertig, $SIZE Byte"

# Am 1. des Monats zusätzlich als Monatssicherung ablegen
if [ "$(date +%d)" = "01" ]; then cp "$OUT" "$DEST/monthly/rhetoriq-$(date +%Y-%m).dump.$EXT"; fi

# Aufbewahrung
find "$DEST/daily" -name 'rhetoriq-*.dump.*' -type f -mtime +"${BACKUP_KEEP_DAILY:-30}" -delete
find "$DEST/monthly" -name 'rhetoriq-*.dump.*' -type f -mtime +"${BACKUP_KEEP_MONTHLY:-365}" -delete

ping_ok
log "Erfolgreich"
