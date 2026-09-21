#!/usr/bin/env python3
"""Read-only native-6 evidence. Prints aggregates only, never credential values."""
import hashlib,importlib.util,json,subprocess,time
from pathlib import Path
from urllib.parse import urlparse,unquote
ops=Path('/root/duduhire-upgrade-native6')
spec=importlib.util.spec_from_file_location('upgrade',str(ops/'upgrade.py'))
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
start=int((ops/'activated-epoch').read_text())
rows=[json.loads(line) for line in (ops/'stability.jsonl').read_text().splitlines()]
services={}
for unit in ['duduhire-api-staging.service','nginx.service','duduhire-backup.timer']:
 services[unit]=dict(line.split('=',1) for line in u.run(['systemctl','show',unit,'--no-pager','--property=MainPID,NRestarts,ActiveState,UnitFileState']).decode().splitlines() if '=' in line)
counts={'warn':0,'error':0,'fatal':0,'total':0,'non_json':0}
raw=u.run(['journalctl','-u','duduhire-api-staging.service','--since=@'+str(start),'--no-pager','--output=json'],timeout=30)
for line in raw.splitlines():
 row=json.loads(line);message=row.get('MESSAGE','')
 try: entry=json.loads(message)
 except (ValueError,TypeError):counts['non_json']+=1;continue
 counts['total']+=1;level=entry.get('level',0)
 if isinstance(level,int):
  if level>=60:counts['fatal']+=1
  elif level>=50:counts['error']+=1
  elif level>=40:counts['warn']+=1
backup=json.loads((ops/'database-backup-result.json').read_text())
backup['sha256']=hashlib.sha256(Path(backup['file']).read_bytes()).hexdigest()
values=u.parse_env(u.RUNTIME)
phone={k:values.get(k) for k in ['PHONE_AUTH_ENABLED','PHONE_AUTH_ALLOW_ALL_NUMBERS','PHONE_AUTH_DAILY_LIMIT']}
phone['deadline_absent']='PHONE_AUTH_SEND_UNTIL' not in values
migration=u.parse_env(Path('/etc/duduhire/migration.env'));url=urlparse(migration['MIGRATION_DATABASE_URL'])
env=dict(u.ENV);env.update(PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=unquote(url.username),PGPASSWORD=unquote(url.password),PGDATABASE='duduhire',PGSSLMODE='verify-full',PGSSLROOTCERT='/etc/duduhire/ca.crt',PGCONNECT_TIMEOUT='5')
query="SELECT json_build_object('users',(SELECT count(*) FROM users),'listings',(SELECT count(*) FROM matching_listings),'examples',(SELECT json_object_agg(kind,n) FROM (SELECT kind,count(*) n FROM matching_examples GROUP BY kind) x),'migrations',(SELECT count(*) FROM schema_migrations),'invalid_session_roles',(SELECT count(*) FROM sessions WHERE active_role IS NULL OR active_role NOT IN ('client','talent')))"
database=json.loads(u.run(['psql','-X','-At','-v','ON_ERROR_STOP=1','-c',query],env=env).decode())
u.verify_candidate()
print(json.dumps({'release':u.CURRENT.resolve().name,'payload_verified':True,'nginx_sha':u.digest(u.NGINX),'services':services,'backup':backup,'database':database,'phone':phone,'pino':counts,'activated_epoch':start,'elapsed_seconds':int(time.time())-start,'stability':rows[-1]},indent=2))
