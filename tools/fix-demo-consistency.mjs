// Narrow, reviewable repair for the initial synthetic dataset only.
// Default is a read-only dry run. --apply is required to change the demo rows.
import { Client } from 'pg';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.loadEnvFile(path.join(root,'.env'));
if(process.argv.slice(2).some(arg=>arg!=='--apply')) throw new Error('Usage: fix-demo-consistency.mjs [--apply]');
const apply=process.argv.includes('--apply');
const client=new Client({ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:true},
  connectionTimeoutMillis:12000,statement_timeout:60000,application_name:'medcore-demo-consistency-correction'});
const report={performedAt:new Date().toISOString(),mode:apply?'apply':'read-only-dry-run',schema:'project',result:'pending'};
const sourceCases=`SELECT r.case_id,max(r.issued_at) AS last_issued_at
  FROM project.referrals r JOIN project.medical_cases c ON c.id=r.case_id
  WHERE r.reason LIKE 'Вымышленное направление №%'
    AND c.reason LIKE 'Вымышленное амбулаторное обращение №%'
    AND c.case_type='outpatient' AND c.status='closed'
  GROUP BY r.case_id`;
let committed=false;
try{
  await client.connect();
  const identity=(await client.query('SELECT current_database() AS database,current_user AS username')).rows[0];
  if(identity.database!=='db_a_s_yakovlev'||identity.username!=='a-s-yakovlev') throw new Error('Unexpected database identity');
  await client.query(apply?'BEGIN':'BEGIN READ ONLY');
  if(apply){
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query('SELECT pg_advisory_xact_lock(1296389187,1)');
  }
  const owner=(await client.query("SELECT pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname='project'")).rows[0];
  if(!owner?.owned) throw new Error('Unexpected project schema owner');
  report.baseline=(await client.query(`SELECT
    (SELECT count(*)::int FROM project.patients) AS patients,
    (SELECT count(*)::int FROM project.employees) AS employees,
    (SELECT count(*)::int FROM project.doctors) AS doctors,
    (SELECT count(*)::int FROM project.medical_cases) AS cases,
    (SELECT count(*)::int FROM project.referrals) AS referrals,
    (SELECT count(*)::int FROM project.users) AS users`)).rows[0];
  if(report.baseline.patients!==1000||report.baseline.employees!==200||report.baseline.doctors!==120
    ||report.baseline.cases!==2000||report.baseline.referrals!==500||report.baseline.users!==6) {
    throw new Error('Unexpected dataset size; repair requires review instead of broad changes');
  }
  const hospital=(await client.query("SELECT id FROM project.medical_organizations WHERE organization_type='hospital' AND name='Учебная городская больница №1'")).rows;
  const clinic=(await client.query("SELECT id FROM project.medical_organizations WHERE organization_type='polyclinic' AND name='Учебная поликлиника №1'")).rows;
  if(hospital.length!==1||clinic.length!==1) throw new Error('Demo institution markers are not unique');
  const hospitalId=hospital[0].id,clinicId=clinic[0].id;
  const accounts=(await client.query(`SELECT u.login,u.employee_id FROM project.users u
    JOIN project.employees e ON e.id=u.employee_id
    WHERE (u.login='manager' AND e.email='employee122@example.test')
       OR (u.login='registrar' AND e.email='employee123@example.test') ORDER BY u.login`)).rows;
  if(accounts.length!==2) throw new Error('Demo account markers do not match');
  const employeeIds=accounts.map(row=>row.employee_id);
  const scopedRows=(await client.query(`SELECT count(*)::int AS count FROM project.user_organization_scopes s
      JOIN project.users u ON u.id=s.user_id JOIN project.roles r ON r.id=s.role_id
      WHERE ((u.login='manager' AND r.code='organization_admin') OR (u.login='registrar' AND r.code='registrar'))
        AND s.organization_id=ANY($1::bigint[])`,[[hospitalId,clinicId]])).rows[0].count;
  if(scopedRows!==4) throw new Error('Manager/registrar scope markers do not match');
  const markedSources=(await client.query(`SELECT count(*)::int AS count FROM (${sourceCases}) src`)).rows[0].count;
  if(markedSources!==500) throw new Error('Expected exactly 500 uniquely marked referral source cases');
  const lateSources=(await client.query(`SELECT count(*)::int AS count FROM project.medical_cases c
    JOIN (${sourceCases}) src ON src.case_id=c.id WHERE c.closed_at<src.last_issued_at`)).rows[0].count;
  const hospitalEmployments=(await client.query(`SELECT e.id,e.employee_id,e.organization_id
    FROM project.employments e JOIN project.hospitals h ON h.organization_id=e.organization_id
    WHERE e.employee_id=ANY($1::bigint[]) AND e.ended_on IS NULL AND e.started_on='2010-01-01'::date`,[employeeIds])).rows;
  if(hospitalEmployments.length!==2) throw new Error('Expected one marked hospital employment per demo account');
  const moveIds=hospitalEmployments.filter(row=>String(row.organization_id)!==String(hospitalId)).map(row=>row.id);
  const missingClinic=(await client.query(`SELECT id FROM project.employees e WHERE e.id=ANY($1::bigint[])
    AND NOT EXISTS(SELECT 1 FROM project.employments em WHERE em.employee_id=e.id
      AND em.organization_id=$2 AND em.ended_on IS NULL)`,[employeeIds,clinicId])).rows.map(row=>row.id);
  if(![0,500].includes(lateSources)||![0,2].includes(moveIds.length)||![0,2].includes(missingClinic.length)) {
    throw new Error('Partially changed demo history needs a fresh review; no rows changed');
  }
  report.plannedChanges={sourceCaseClosureDates:lateSources,hospitalEmploymentsToMove:moveIds.length,
    clinicEmploymentsToAdd:missingClinic.length};
  if(apply){
    const changedCases=await client.query(`UPDATE project.medical_cases c
      SET closed_at=src.last_issued_at+interval '1 hour'
      FROM (${sourceCases}) src WHERE c.id=src.case_id
        AND c.reason LIKE 'Вымышленное амбулаторное обращение №%'
        AND c.case_type='outpatient' AND c.status='closed' AND c.closed_at<src.last_issued_at`);
    const moved=await client.query('UPDATE project.employments SET organization_id=$1 WHERE id=ANY($2::bigint[])',[hospitalId,moveIds]);
    const added=await client.query(`INSERT INTO project.employments(employee_id,organization_id,position_name,started_on,workload_fraction)
      SELECT id,$1,'Сотрудник по совместительству','2012-01-01'::date,0.5
      FROM project.employees WHERE id=ANY($2::bigint[])`,[clinicId,missingClinic]);
    if(changedCases.rowCount!==lateSources||moved.rowCount!==moveIds.length||added.rowCount!==missingClinic.length) {
      throw new Error('Changed row count differs from reviewed plan');
    }
    await client.query('SELECT project.fn_assert_business_rules()');
    const residual=(await client.query(`SELECT count(*)::int AS count FROM project.medical_cases c
      JOIN (${sourceCases}) src ON src.case_id=c.id
      WHERE c.closed_at<src.last_issued_at OR c.opened_at>src.last_issued_at`)).rows[0].count;
    const unmatchedScopes=(await client.query(`SELECT count(*)::int AS count FROM project.user_organization_scopes s
      JOIN project.users u ON u.id=s.user_id WHERE u.login IN ('manager','registrar','doctor')
      AND s.organization_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM project.employments e
        WHERE e.employee_id=u.employee_id AND e.organization_id=s.organization_id AND e.ended_on IS NULL)`)).rows[0].count;
    if(residual!==0||unmatchedScopes!==0) throw new Error('Consistency postcondition failed');
    report.appliedChanges={sourceCaseClosureDates:changedCases.rowCount,hospitalEmploymentsMoved:moved.rowCount,
      clinicEmploymentsAdded:added.rowCount};
    await client.query('COMMIT');committed=true;
    report.result='passed';
  }else{
    await client.query('ROLLBACK');
    report.result='review_ready';
  }
  console.log(JSON.stringify({mode:report.mode,result:report.result,plannedChanges:report.plannedChanges,
    appliedChanges:report.appliedChanges},null,2));
}catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  report.result='failed';report.committed=committed;
  let message=String(error.message);
  for(const secret of [process.env.PGPASSWORD,process.env.MEDCORE_DEMO_PASSWORD].filter(Boolean)) message=message.replaceAll(secret,'[redacted]');
  report.error={code:error.code,message};console.error(JSON.stringify(report.error));process.exitCode=1;
}finally{
  await client.end().catch(()=>{});
  const dir=path.join(root,'docs/database/checks');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'demo-consistency-correction.json'),JSON.stringify(report,null,2)+'\n');
}
