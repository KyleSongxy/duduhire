// Explicit operator import for the user's 20/100 production mock request.
// Deliberately separate from the development-only seed command; that guard stays intact.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
const release='/opt/duduhire/releases/duduhire-20260913-native-4';
const version='mock-20260913-20-demands-100-capabilities-v1';
const check=(v,code)=>{if(!v)throw new Error(code);};
let pool, client, phase='preconditions';
try {
  check(process.argv.length===4 && process.argv[2]==='--apply-authorized-mock', 'explicit_mode_required');
  check(realpathSync('/opt/duduhire/current')===release,'release_changed');
  const raw=readFileSync(process.argv[3]);
  const {records,version:batchVersion}=JSON.parse(raw);
  check(batchVersion===version && records.length===120,'batch_invalid');
  check(records.filter(r=>r.kind==='problem').length===20 && records.filter(r=>r.kind==='capability').length===100,'counts_invalid');
  check(new Set(records.map(r=>r.id)).size===120,'duplicate_ids');
  const {validateMatchingDraft,rankMatches}=await import(release+'/apps/api/dist/matching.js');
  const {loadDatabaseConfig}=await import(release+'/apps/api/dist/config.js');
  const {createDatabasePool}=await import(release+'/apps/api/dist/postgresRepository.js');
  for(const r of records){
    check(/^example-20260913-(demand-\d{2}|capability-\d{2}-[1-5])$/.test(r.id),'unexpected_id');
    check(['ai','global'].includes(r.domain),'domain_invalid');
    check(r.draft.title.startsWith('示例') && r.draft.summary.startsWith('虚构') && r.draft.notes.startsWith('Mock 数据'),'missing_mock_label');
    r.draft=validateMatchingDraft(r.kind,r.draft);
  }
  const config=loadDatabaseConfig(process.env),url=new URL(config.databaseUrl);
  check(config.databaseSsl && ['localhost','127.0.0.1'].includes(url.hostname) && url.pathname==='/duduhire' && url.username==='duduhire_owner','database_target_invalid');
  pool=createDatabasePool(config.databaseUrl,config.databaseSsl,'migration');client=await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='15s'");
  await client.query('SELECT pg_advisory_xact_lock($1)',[1_197_873_442]);
  await client.query('LOCK TABLE matching_examples IN SHARE ROW EXCLUSIVE MODE');
  phase='insert_and_verify';
  const ids=records.map(r=>r.id);
  const untouched=async()=> (await client.query("SELECT md5(COALESCE(string_agg(t::text,'' ORDER BY id),'')) AS hash FROM matching_examples t WHERE NOT(id=ANY($1::text[]))",[ids])).rows[0].hash;
  const beforeHash=await untouched();
  const before=(await client.query('SELECT kind,count(*)::int AS count FROM matching_examples GROUP BY kind ORDER BY kind')).rows;
  let inserted=0;
  for(const r of records){
    const result=await client.query('INSERT INTO matching_examples(id,kind,domain,draft,seed_version) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(id) DO NOTHING',[r.id,r.kind,r.domain,JSON.stringify(r.draft),version]);
    inserted+=result.rowCount;
    const same=await client.query('SELECT 1 FROM matching_examples WHERE id=$1 AND kind=$2 AND domain=$3 AND draft=$4::jsonb AND seed_version=$5',[r.id,r.kind,r.domain,JSON.stringify(r.draft),version]);
    check(same.rowCount===1,'existing_record_conflict');
  }
  check(await untouched()===beforeHash,'unrelated_examples_changed');
  const stored=(await client.query('SELECT id,kind,domain,draft FROM matching_examples WHERE seed_version=$1 ORDER BY id',[version])).rows;
  check(stored.length===120,'stored_count_mismatch');
  const listing=r=>({...validateMatchingDraft(r.kind,r.draft),id:r.id,kind:r.kind,version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),isExample:true,contactable:false});
  const capabilities=stored.filter(r=>r.kind==='capability').map(listing), demands=stored.filter(r=>r.kind==='problem').map(listing);
  const counts=demands.map(d=>rankMatches(d,capabilities).length);
  check(Math.min(...counts)>0,'database_matching_failed');
  // Match the application's ORDER/LIMIT so this complete batch is actually readable.
  for(const kind of ['problem','capability']) {
    const visible=(await client.query('SELECT id FROM matching_examples WHERE kind=$1 ORDER BY id LIMIT 100',[kind])).rows.map(r=>r.id);
    check(stored.filter(r=>r.kind===kind).every(r=>visible.includes(r.id)),'batch_outside_application_limit');
  }
  const after=(await client.query('SELECT kind,count(*)::int AS count FROM matching_examples GROUP BY kind ORDER BY kind')).rows;
  await client.query('COMMIT');phase='committed';
  console.log(JSON.stringify({status:'committed',version,sha256:createHash('sha256').update(raw).digest('hex'),inserted,batch:{demands:20,capabilities:100},before,after,unrelatedExamplesUnchanged:true,minimumMatches:Math.min(...counts),applicationLimitVerified:true,accountsCreated:0,contactsCreated:0}));
}catch {
  if(client && phase!=='committed')await client.query('ROLLBACK').catch(()=>{});
  console.log(JSON.stringify({status:'failed',phase,detailsSuppressed:true}));process.exitCode=1;
}finally{client?.release();if(pool)await pool.end();}
