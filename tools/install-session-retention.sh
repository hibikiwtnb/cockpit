#!/bin/bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
    echo 'Run with sudo.' >&2
    exit 1
fi
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
installed_version=$(dpkg-query -W -f='${Version}' cockpit-ws)
case "$installed_version" in
    362-*) ;;
    *) echo "Expected Cockpit 362, found $installed_version" >&2; exit 1 ;;
esac
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir=/var/backups/cockpit/session-$stamp
install -d "$backup_dir" /usr/local/libexec/cockpit /etc/cockpit
for path in /etc/cockpit/cockpit.conf /etc/systemd/system/cockpit-wsinstance-https@.service.d /etc/systemd/system/cockpit-wsinstance-http.service.d /usr/local/libexec/cockpit/cockpit-ws; do
    if [ -e "$path" ]; then cp -a --parents "$path" "$backup_dir/"; fi
done
install -o root -g root -m 755 "$source_dir/cockpit-ws" /usr/local/libexec/cockpit/cockpit-ws
python3 - <<'PY'
import configparser
from pathlib import Path
path = Path('/etc/cockpit/cockpit.conf')
config = configparser.ConfigParser(interpolation=None)
config.optionxform = str
config.read(path)
if not config.has_section('Session'):
    config.add_section('Session')
config.set('Session', 'DisconnectTimeout', '86400')
with path.open('w') as stream:
    config.write(stream)
PY
for unit in cockpit-wsinstance-https@.service cockpit-wsinstance-http.service; do
    install -d "/etc/systemd/system/$unit.d"
    flag=--for-tls-proxy
    if [ "$unit" = cockpit-wsinstance-http.service ]; then flag=--no-tls; fi
    printf '[Service]\nExecStart=\nExecStart=/usr/local/libexec/cockpit/cockpit-ws %s --port=0\n' "$flag" > "/etc/systemd/system/$unit.d/session-retention.conf"
done
systemctl daemon-reload
systemctl restart cockpit.service
curl -ksSf -o /dev/null https://localhost:9090/
printf 'Disconnected sessions retained for 86400 seconds. Backup: %s\n' "$backup_dir"
