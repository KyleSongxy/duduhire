#!/usr/bin/env python3
"""Fixed native-3 to native-4 upgrade. Python 3.6; secret values never logged."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import time
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

OPS = Path('/root/duduhire-upgrade-native4')
OLD = Path('/opt/duduhire/releases/duduhire-20260912-native-3')
NEW = Path('/opt/duduhire/releases/duduhire-20260913-native-4')
CURRENT = Path('/opt/duduhire/current')
UNIT = Path('/etc/systemd/system/duduhire-api-staging.service')
RUNTIME = Path('/etc/duduhire/runtime.env')
NGINX = Path('/etc/nginx/conf.d/kylesong.conf')
DELTA = Path('/root/duduhire-native-4-delta.tar.gz')
DELTA_SHA = '1d28f767d7e698bc6efed5655b0afe9d91b4eca29467347e374ba2d5cd37f63c'
MANIFEST_SHA = '456842436a9e2a41ecd0fa1f2b8ade7bc3ea6887d79b4679eb927ec78f70c198'
NGINX_SHA = 'e653e6204518558300d3f6f0557d6b27c155fa01f4e100b9d247d3a6e9d9df8f'
ENV = {'PATH':'/usr/local/bin:/usr/pgsql-13/bin:/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C','SYSTEMD_PAGER':'cat'}
PHASE = 'preconditions'

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def phase(name):
    global PHASE
    PHASE = name
    print('PHASE=' + name, flush=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(args, timeout=90, env=None):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env=env or ENV)
    require(result.returncode == 0, 'command_failed_' + Path(args[0]).name)
    return result.stdout

def private_file(path):
    info = path.lstat()
    require(path.resolve()==path and stat.S_ISREG(info.st_mode) and info.st_uid==0
            and info.st_nlink==1 and stat.S_IMODE(info.st_mode)==0o600, 'private_file_invalid')

def parse_env(path):
    private_file(path)
    values = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)='([^'\\\r\n\x00]*)'", line)
        require(match is not None and match.group(1) not in values, 'env_format_changed')
        values[match.group(1)] = match.group(2)
    return values

def write_new(path, data, mode=0o600):
    with path.open('xb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def replace_file(path, data, mode):
    tmp = path.parent / ('.' + path.name + '.native4-next')
    require(not os.path.lexists(str(tmp)), 'temporary_file_exists')
    try:
        write_new(tmp, data, mode)
        os.replace(str(tmp), str(path))
    finally:
        if tmp.exists():tmp.unlink()

def point_current(target):
    tmp = CURRENT.parent / '.current.native4-next'
    require(not os.path.lexists(str(tmp)), 'temporary_link_exists')
    try:
        tmp.symlink_to(target)
        os.replace(str(tmp), str(CURRENT))
    finally:
        if os.path.lexists(str(tmp)):tmp.unlink()

def manifest(data):
    result = {}
    for line in data.decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_./-]+)', line)
        require(match is not None, 'invalid_manifest')
        sha, name = match.groups()
        require(not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/'))
                and name not in result, 'invalid_manifest_path')
        result[name] = sha
    return result

def verify_candidate():
    require(digest(NEW/'SHA256SUMS')==MANIFEST_SHA,'candidate_manifest_changed')
    for name,sha in manifest((NEW/'SHA256SUMS').read_bytes()).items():
        path=NEW/name
        info=path.lstat()
        require(path.resolve()==path and stat.S_ISREG(info.st_mode) and info.st_uid==0
                and not info.st_mode & 0o022 and digest(path)==sha,'candidate_payload_changed')
    expected=parse_env(OPS/'runtime.before.env')
    expected['QWEN_MODEL']='qwen3.8-max'
    require(parse_env(OPS/'runtime.candidate.env')==expected,'candidate_runtime_changed')

def request(port, route, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = Request('http://127.0.0.1:'+str(port)+route, data=data,
                  headers={'Content-Type':'application/json','Origin':'https://kylesong.top'})
    try:
        response = build_opener(ProxyHandler({})).open(req, timeout=4)
    except HTTPError as error:
        response = error
    with response:
        return response.code, json.loads(response.read(65536))

def ready(port):
    until = time.monotonic()+35
    while time.monotonic()<until:
        try:
            require(request(port,'/api/health/live')==(200,{'status':'ok'}), 'live')
            status, body = request(port,'/api/health/ready')
            require(status==200 and body.get('status')=='ready', 'ready')
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('health_timeout')

def negative_auth(port, values):
    status, body = request(port,'/api/v1/auth/methods')
    require(status==200 and body['email']['available'] is True, 'email_unavailable')
    email='native4-acceptance@example.invalid'
    require(request(port,'/api/v1/auth/login-eligibility',{'method':'email','account':email})
            ==(200,{'registered':False}), 'synthetic_account_unexpected')
    status, body = request(port,'/api/v1/auth/email/challenges',{'email':email,'intent':'login'})
    require(status==409 and body['error']['code']=='ACCOUNT_NOT_REGISTERED','email_login_regression')
    phone=values['PHONE_AUTH_ALLOWED_NUMBERS'].split(',')[0]
    status, body=request(port,'/api/v1/auth/login-eligibility',{'method':'phone','account':phone})
    require(status==200 and isinstance(body.get('registered'),bool),'phone_eligibility_failed')
    # Never POST a real phone challenge in an automatic smoke test: a user could
    # register between the eligibility read and POST, causing an unintended SMS.
    print('phone_eligibility_checked=true; sms_challenge_not_requested=true',flush=True)
    print('email_unregistered_login_rejected=true; emails_sent=0',flush=True)

def stage():
    require(CURRENT.resolve()==OLD and not NEW.exists(), 'unexpected_current_or_existing_candidate')
    require(digest(NGINX)==NGINX_SHA, 'nginx_changed')
    require(not (OPS/'STAGE_STARTED').exists(), 'stage_already_attempted')
    original=parse_env(RUNTIME)
    require(original['EMAIL_DELIVERY_MODE']=='smtp' and original['PORT']=='8788', 'runtime_changed')
    require(str(OLD) in UNIT.read_text(), 'unit_changed')
    require(digest(DELTA)==DELTA_SHA,'delta_sha_mismatch')
    write_new(OPS/'STAGE_STARTED',b'stage started\n')
    phase('backup')
    for name,path in [('runtime.before.env',RUNTIME),('unit.before',UNIT),('nginx.before',NGINX)]:
        write_new(OPS/name,path.read_bytes())
    write_new(OPS/'current.before',os.readlink(str(CURRENT)).encode())
    backup=run(['/usr/local/bin/node','/opt/duduhire/ops/backup-duduhire.mjs'],timeout=120)
    write_new(OPS/'database-backup-result.json',backup)
    print(backup.decode(),flush=True)
    phase('reconstruct_and_verify_release')
    entries={}
    with tarfile.open(str(DELTA),'r:gz') as archive:
        for entry in archive:
            require(entry.isfile() and entry.name not in entries and entry.size<20*1024*1024,
                    'invalid_delta_member')
            require(re.fullmatch(r'[A-Za-z0-9_./-]+',entry.name) is not None
                    and not entry.name.startswith('/') and all(p not in ('','.','..') for p in entry.name.split('/')),
                    'invalid_delta_path')
            entries[entry.name]=archive.extractfile(entry).read()
    require(hashlib.sha256(entries['SHA256SUMS']).hexdigest()==MANIFEST_SHA,'manifest_sha_mismatch')
    desired=manifest(entries['SHA256SUMS'])
    require(set(entries).issubset(set(desired)|{'SHA256SUMS'}),'extra_delta_files')
    old_manifest=manifest((OLD/'SHA256SUMS').read_bytes())
    for name,sha in old_manifest.items():
        require((OLD/name).resolve()==OLD/name and digest(OLD/name)==sha,'baseline_payload_changed')
    NEW.mkdir(mode=0o755)
    for name,sha in desired.items():
        path=NEW/name
        path.parent.mkdir(parents=True,exist_ok=True)
        if name in entries:
            require(hashlib.sha256(entries[name]).hexdigest()==sha,'delta_payload_mismatch')
            write_new(path,entries[name],0o644)
        else:
            require(old_manifest.get(name)==sha,'reused_payload_mismatch')
            shutil.copyfile(str(OLD/name),str(path));path.chmod(0o644)
    write_new(NEW/'SHA256SUMS',entries['SHA256SUMS'],0o644)
    for folder,dirs,files in os.walk(str(NEW)):
        os.chmod(folder,0o755)
    for name in ['package.json','package-lock.json','apps/api/package.json','apps/web/package.json']:
        require(digest(OLD/name)==digest(NEW/name),'dependency_manifest_changed')
    require(all(digest(OLD/name)==sha for name,sha in desired.items() if name.startswith('apps/api/migrations/')),
            'migration_changed')
    run(['cp','-a',str(OLD/'node_modules'),str(NEW/'node_modules')],timeout=120)
    if (OLD/'apps/api/node_modules').exists():
        run(['cp','-a',str(OLD/'apps/api/node_modules'),str(NEW/'apps/api/node_modules')],timeout=120)
    for name,sha in desired.items():require(digest(NEW/name)==sha,'reconstructed_manifest_failed')
    candidate=dict(original);candidate['QWEN_MODEL']='qwen3.8-max'
    write_new(OPS/'runtime.candidate.env', ''.join(k+"='"+v+"'\n" for k,v in candidate.items()).encode())
    verify_candidate()
    private_file(OPS/'qwen-probe.mjs')
    phase('new_model_probe')
    output=run(['/usr/local/bin/node',str(OPS/'qwen-probe.mjs')],timeout=35)
    write_new(OPS/'qwen-result.json',output)
    print(output.decode(),flush=True)
    phase('preview_API_and_auth_regressions')
    identity=pwd.getpwnam('duduhire')
    def service_identity():
        os.setgroups([]);os.setgid(identity.pw_gid);os.setuid(identity.pw_uid)
    preview=dict(candidate);preview['PORT']='8789';preview.update(ENV)
    require(not run(['ss','-H','-ltn','sport = :8789']).strip(),'preview_port_occupied')
    with (OPS/'preview.log').open('xb') as logfile:
        child=subprocess.Popen(['/usr/local/bin/node',str(NEW/'apps/api/dist/server.js')],
            cwd=str(NEW),env=preview,stdin=subprocess.DEVNULL,stdout=logfile,stderr=subprocess.STDOUT,
            preexec_fn=service_identity)
        try:
            ready(8789);negative_auth(8789,candidate)
        finally:
            child.terminate()
            try:child.wait(timeout=20)
            except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
    write_new(OPS/'STAGED',b'payload, model, preview health and negative auth passed\n')
    print('NATIVE4_STAGED; production_unchanged=true',flush=True)

def activate():
    require((OPS/'STAGED').is_file() and not (OPS/'ACTIVATION_STARTED').exists(),'stage_or_activation_invalid')
    require(CURRENT.resolve()==OLD and digest(NGINX)==NGINX_SHA,'live_state_changed')
    require(RUNTIME.read_bytes()==(OPS/'runtime.before.env').read_bytes()
            and UNIT.read_bytes()==(OPS/'unit.before').read_bytes(),'configuration_changed')
    verify_candidate()
    write_new(OPS/'ACTIVATION_STARTED',b'activation started\n')
    phase('activate')
    try:
        replace_file(RUNTIME,(OPS/'runtime.candidate.env').read_bytes(),0o600)
        replace_file(UNIT,(OPS/'unit.before').read_bytes().replace(str(OLD).encode(),str(NEW).encode())
                     .replace(b'duduhire-20260912-native-3',b'duduhire-20260913-native-4'),0o644)
        run(['systemctl','daemon-reload'])
        run(['systemctl','restart',UNIT.name])
        ready(8788)
        negative_auth(8788,parse_env(RUNTIME))
        point_current('releases/'+NEW.name)
        run(['nginx','-t'])
        run(['systemctl','reload','nginx'])
        require(digest(NGINX)==NGINX_SHA,'nginx_unexpected_change')
    except BaseException:
        phase('rollback')
        replace_file(RUNTIME,(OPS/'runtime.before.env').read_bytes(),0o600)
        replace_file(UNIT,(OPS/'unit.before').read_bytes(),0o644)
        point_current((OPS/'current.before').read_text())
        run(['systemctl','daemon-reload']);run(['systemctl','restart',UNIT.name])
        run(['nginx','-t']);run(['systemctl','reload','nginx']);ready(8788)
        write_new(OPS/'ROLLED_BACK',b'original API, runtime and web restored\n')
        raise RuntimeError('activation_failed_and_rolled_back')
    write_new(OPS/'COMPLETE',b'native4 activated; public browser acceptance remains\n')
    print('NATIVE4_ACTIVATED; browser_and_stability_acceptance_pending=true',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['stage','activate'])
    args=parser.parse_args()
    try:
        require(os.geteuid()==0 and os.uname().sysname=='Linux','Linux_root_required')
        os.umask(0o077)
        info=OPS.lstat()
        require(OPS.resolve()==OPS and stat.S_ISDIR(info.st_mode) and info.st_uid==0
                and stat.S_IMODE(info.st_mode)==0o700,'private_operations_directory_required')
        for parent in OPS.parents:
            info=parent.lstat()
            require(parent.resolve()==parent and info.st_uid==0 and not info.st_mode & 0o022,
                    'operations_parent_untrusted')
        def interrupted(number,frame):raise RuntimeError('signal_interrupted')
        for number in (signal.SIGTERM,signal.SIGHUP,signal.SIGQUIT):signal.signal(number,interrupted)
        stage() if args.mode=='stage' else activate()
    except Exception as error:
        detail=str(error) if type(error) is RuntimeError else type(error).__name__
        print('UPGRADE_FAILED phase='+PHASE+' code='+detail+'; details_suppressed',flush=True)
        raise SystemExit(1)
