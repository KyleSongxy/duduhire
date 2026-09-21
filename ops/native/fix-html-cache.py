#!/usr/bin/env python3
"""Narrow, hash-pinned HTML cache repair. --check never writes or runs Nginx."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time


CONFIG = Path('/etc/nginx/conf.d/kylesong.conf')
BACKUPS = Path('/root/duduhire-backups')
EXPECTED = 'adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4'
ANCHOR = b'  location / {\n    try_files $uri $uri/ /index.html;\n  }'
INSERT = (b'  location = /index.html {\n'
          b'    expires -1;\n'
          b'    if_modified_since off;\n'
          b'    etag off;\n'
          b'  }\n\n')


class RepairError(Exception):
    pass


def require(ok, message):
    if not ok:
        raise RepairError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inspect(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode), 'Configuration must be a regular file, not a symlink')
    source = path.read_bytes()
    require(digest(source) == EXPECTED, 'Configuration hash differs from the reviewed deployment; no change made')
    require(source.count(ANCHOR) == 1, 'Expected exactly one reviewed SPA location')
    proposed = source.replace(ANCHOR, INSERT + ANCHOR, 1)
    return source, proposed, metadata


def atomic(path, data, mode, uid=None, gid=None):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            if uid is not None:
                os.fchown(handle.fileno(), uid, gid)
            os.fsync(handle.fileno())
        os.replace(temporary, str(path))
        parent = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def nginx(arguments, backup, label):
    try:
        result = subprocess.run(['/usr/sbin/nginx'] + arguments,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        atomic(backup / (label + '.log'), result.stdout, 0o600)
        require(result.returncode == 0, label + ' failed; details retained in private backup')
    except subprocess.TimeoutExpired:
        raise RepairError(label + ' timed out')


def apply(path, backup_root):
    source, proposed, metadata = inspect(path)
    base = backup_root.lstat()
    require(stat.S_ISDIR(base.st_mode) and base.st_uid == 0 and stat.S_IMODE(base.st_mode) == 0o700,
            'Backup base must already be a root-owned 0700 directory')
    require(metadata.st_uid == 0 and not (metadata.st_mode & 0o022),
            'Configuration must be root-owned and not group/world writable')
    backup = Path(tempfile.mkdtemp(prefix='html-cache-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-',
                                   dir=str(backup_root)))
    atomic(backup / 'before.conf', source, 0o600)
    atomic(backup / 'candidate.conf', proposed, 0o600)
    evidence = {'config': str(path), 'beforeSha256': digest(source), 'candidateSha256': digest(proposed)}
    atomic(backup / 'manifest.json', (json.dumps(evidence, sort_keys=True) + '\n').encode('utf-8'), 0o600)
    require(path.read_bytes() == source, 'Configuration changed during preparation; no change made')
    mode = stat.S_IMODE(metadata.st_mode)
    changed = False
    try:
        changed = True  # Also roll back if replace succeeds but its directory fsync fails.
        atomic(path, proposed, mode, metadata.st_uid, metadata.st_gid)
        nginx(['-t'], backup, 'candidate-test')
        nginx(['-s', 'reload'], backup, 'candidate-reload')
        require(path.read_bytes() == proposed, 'Configuration changed unexpectedly after reload')
    except BaseException:
        if changed:
            try:
                atomic(path, source, mode, metadata.st_uid, metadata.st_gid)
                nginx(['-t'], backup, 'rollback-test')
                nginx(['-s', 'reload'], backup, 'rollback-reload')
                require(path.read_bytes() == source, 'Rollback file verification failed')
            except BaseException:
                raise RepairError('REPAIR_FAILED_ROLLBACK_NEEDS_ATTENTION backup=' + str(backup))
        raise RepairError('REPAIR_FAILED_ORIGINAL_RESTORED backup=' + str(backup))
    print(json.dumps(dict(evidence, status='RELOADED', backup=str(backup)), sort_keys=True))


def interrupted(signum, frame):
    raise RepairError('Interrupted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check', action='store_true')
    action.add_argument('--apply', action='store_true')
    parser.add_argument('--config', type=Path, default=CONFIG, help='Alternate input is permitted only with --check')
    args = parser.parse_args()
    if args.check:
        source, proposed, unused = inspect(args.config)
        print(json.dumps({'status': 'CHECKED_ONLY', 'beforeSha256': digest(source),
                          'candidateSha256': digest(proposed), 'insertedLocation': '= /index.html'}, sort_keys=True))
        return
    require(sys.platform.startswith('linux') and os.geteuid() == 0, '--apply requires Linux root')
    require(args.config == CONFIG, '--apply only supports the reviewed production configuration path')
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    apply(CONFIG, BACKUPS)


if __name__ == '__main__':
    try:
        main()
    except (RepairError, OSError) as error:
        print('HTML_CACHE_REPAIR_ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
