#!/usr/bin/env bash
# Target-server staging only. Public Nginx cutover remains a separate step.
set -euo pipefail
umask 077
phase=preconditions
trap 'printf "STAGING_FAILED phase=%s; inspect state before retry\n" "$phase" >&2' ERR
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ]
ops=/root/duduhire-transfer-20260912
archive=/root/duduhire-20260912-native-3.tar.gz
release_id=duduhire-20260912-native-3
release=/opt/duduhire/releases/$release_id
cd "$ops"
[ ! -e staging-started ]
[ ! -e "$release" ]
[ ! -e /opt/duduhire/current ] && [ ! -L /opt/duduhire/current ]
touch staging-started
chmod 0600 /root/provider-secrets.json
phase=verify_release
printf '%s  %s\n' 8a10991fb705b9641ac536484c417fe4a26625edee416546be5d5b10ad50c6bc "$archive" | sha256sum --check --quiet
if [ ! -e "$archive.sha256" ]; then
  cp "$ops/$release_id.tar.gz.sha256" "$archive.sha256"
fi
node "$ops/package-native.mjs" --verify "$archive"
phase=backup_old_deployment
python3 "$ops/bootstrap.py" backup | tee "$ops/backup-step.log"
backup=$(sed -n 's/^backup_directory=//p' "$ops/backup-step.log")
[[ "$backup" =~ ^/root/duduhire-backups/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$ ]]
phase=postgresql_tls
python3 "$ops/bootstrap.py" tls --backup "$backup"
phase=independent_database_and_environment
python3 "$ops/bootstrap.py" database-env --backup "$backup" --provider /root/provider-secrets.json
phase=extract_verified_release
mkdir -m 0755 "$release"
tar -xzf "$archive" -C "$release" --no-same-owner
phase=linux_dependencies
bash "$ops/stage.sh" dependencies "$release_id"
export DUDUHIRE_CA_FILE=/etc/duduhire/ca.crt
for step in validate migrate unit start; do
  phase=$step
  bash "$ops/stage.sh" "$step" "$release_id"
done
phase=prepare_public_cutover
printf '%s  %s\n' 03813275fd24f9bbfb8b6ee47d4ecffb2d50b7c4f0ba1b210bef3ec22c02575d /etc/nginx/conf.d/kylesong.conf | sha256sum --check --quiet
ln -s "releases/$release_id" /opt/duduhire/current
python3 "$ops/cutover.py" prepare --output "$ops/cutover-plan"
printf '%s  %s\n' adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4 "$ops/cutover-plan/candidate.conf" | sha256sum --check --quiet
printf 'STAGING_READY release=%s backup=%s; public nginx unchanged\n' "$release_id" "$backup"
