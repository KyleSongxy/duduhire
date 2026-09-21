#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
service= output= recipient= confirmation=
while (($#)); do
  case $1 in
    --service) service=${2:?}; shift 2;;
    --output) output=${2:?}; shift 2;;
    --recipient) recipient=${2:?}; shift 2;;
    --confirm) confirmation=${2:?}; shift 2;;
    *) die 'Usage: bash ops/backup.sh --service production-backup --output /secure/backup.dump.age --recipient age1... --confirm BACKUP';;
  esac
done
[[ $confirmation = BACKUP && $service =~ ^[A-Za-z0-9_-]+$ && $output = /* && $output = *.age && -n $recipient ]] || die 'Backup requires BACKUP confirmation, a libpq service name, absolute .age output path and encryption recipient.'
[[ ! -e $output && -d $(dirname "$output") ]] || die 'Backup destination must not exist and its protected parent directory must already exist.'
need pg_dump; need age
temporary=$(mktemp "$(dirname "$output")/.duduhire-backup.XXXXXX")
if pg_dump --dbname="service=$service" --format=custom --no-owner --no-privileges 2>/dev/null | age --encrypt --recipient "$recipient" > "$temporary" 2>/dev/null; then
  [[ -s $temporary ]] || die 'Backup output is empty.'
  mv -n "$temporary" "$output"
  [[ ! -e $temporary ]] || die 'Another process created the destination; encrypted backup retained at its temporary path. No file was overwritten.'
  printf '{"status":"encrypted_backup_created","restoreVerified":false}\n'
else
  mv "$temporary" "$temporary.failed"
  die 'Backup failed; partial encrypted output retained with a .failed suffix. No existing backup was replaced.'
fi
