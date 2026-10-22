param(
  [string]$DockerPath,
  [string]$Container = 'supabase_db_hanilog'
)

$ErrorActionPreference = 'Stop'
if (-not $DockerPath) { $DockerPath = (Get-Command docker -ErrorAction Stop).Source }
$ids = @{}
foreach ($name in 'userA','userB','household','pet','plan','planVersion','routine','routineVersion','occurrence','keyA','keyB','retryKey') {
  $ids[$name] = [guid]::NewGuid().ToString()
}
$runTag = [guid]::NewGuid().ToString('N').Substring(0, 10)
$appA = "hanilog-concurrency-$runTag-a"
$appB = "hanilog-concurrency-$runTag-b"
$occurredA = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$occurredB = (Get-Date).AddSeconds(1).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

function Invoke-Psql([string]$Sql, [switch]$AllowFailure) {
  $start = Start-PsqlSession $Sql
  $start.Process.WaitForExit()
  $stdout = $start.Stdout.Result
  $stderr = $start.Stderr.Result
  $result = [pscustomobject]@{ ExitCode = $start.Process.ExitCode; Stdout = $stdout.Trim(); Stderr = $stderr.Trim() }
  $start.Process.Dispose()
  if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
    throw "psql failed ($($result.ExitCode)): $($result.Stderr) $($result.Stdout)"
  }
  return $result
}

function Start-PsqlSession([string]$Sql) {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $DockerPath
  $info.Arguments = "exec -i $Container psql -XAt -v ON_ERROR_STOP=1 -U postgres -d postgres"
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw 'Could not start psql in the local Supabase database container.' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.Write($Sql)
  $process.StandardInput.Close()
  return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
  Write-Output "PASS: $Message"
}

$setup = @"
begin;
insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
 ('$($ids.userA)','authenticated','authenticated','phase21-a-$runTag@example.test',now(),'{}','{}',now(),now()),
 ('$($ids.userB)','authenticated','authenticated','phase21-b-$runTag@example.test',now(),'{}','{}',now(),now());
insert into public.households(id,name,created_by) values('$($ids.household)','Synthetic concurrency $runTag','$($ids.userA)');
insert into public.household_memberships(household_id,user_id,role,status,created_by) values
 ('$($ids.household)','$($ids.userA)','PRIMARY_CAREGIVER','ACTIVE','$($ids.userA)'),
 ('$($ids.household)','$($ids.userB)','CAREGIVER','ACTIVE','$($ids.userA)');
insert into public.pets(id,household_id,name,timezone,created_by) values('$($ids.pet)','$($ids.household)','Synthetic concurrency pet','Asia/Seoul','$($ids.userA)');
insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by) values
 ('$($ids.pet)','$($ids.userA)','CAREGIVER','ACTIVE','$($ids.userA)'),
 ('$($ids.pet)','$($ids.userB)','CAREGIVER','ACTIVE','$($ids.userA)');
insert into public.care_plans(id,pet_id,plan_type,created_by) values('$($ids.plan)','$($ids.pet)','PERSONAL_ROUTINE','$($ids.userA)');
insert into public.care_plan_versions(id,care_plan_id,pet_id,version_no,source,author_id,approval_status,content,content_hash)
 values('$($ids.planVersion)','$($ids.plan)','$($ids.pet)',1,'USER_ENTERED','$($ids.userA)','USER_ENTERED_UNVERIFIED','{"synthetic":true}','phase21-$runTag');
insert into public.care_routines(id,pet_id,care_plan_id,timezone,created_by) values('$($ids.routine)','$($ids.pet)','$($ids.plan)','Asia/Seoul','$($ids.userA)');
insert into public.care_routine_versions(id,routine_id,pet_id,care_plan_id,version_no,care_plan_version_id,recurrence,steps,created_by)
 values('$($ids.routineVersion)','$($ids.routine)','$($ids.pet)','$($ids.plan)',1,'$($ids.planVersion)','{"synthetic":true}','[{"step":"insulin"}]','$($ids.userA)');
insert into public.routine_occurrences(id,pet_id,routine_version_id,care_plan_version_id,care_plan_id,occurrence_key,step_key,event_type,scheduled_local_date,scheduled_local_time,timezone,disambiguation,scheduled_at)
 values('$($ids.occurrence)','$($ids.pet)','$($ids.routineVersion)','$($ids.planVersion)','$($ids.plan)','phase21-$runTag','insulin','insulin',current_date,'12:00','Asia/Seoul','NOT_AMBIGUOUS',now());
commit;
"@

$created = $false
try {
  Invoke-Psql $setup | Out-Null
  $created = $true
  Write-Output "Fixture pet=$($ids.pet) occurrence=$($ids.occurrence) synthetic_only=true"

  $sessionA = @"
begin;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"$($ids.userA)","role":"authenticated"}',true);
set local application_name = '$appA';
select 'A_LOCK|' || pg_backend_pid() || '|' || clock_timestamp();
select pg_advisory_xact_lock(hashtextextended('$($ids.pet):$($ids.occurrence):insulin',0));
select pg_sleep(7);
select public.record_health_event('$($ids.pet)','insulin','$occurredA','$($ids.occurrence)','{"synthetic_test":"phase21"}'::jsonb,null,'$($ids.keyA)'::uuid,'Asia/Seoul',null);
commit;
"@
  $sessionB = @"
begin;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"$($ids.userB)","role":"authenticated"}',true);
set local application_name = '$appB';
select 'B_RPC|' || pg_backend_pid() || '|' || clock_timestamp();
select public.record_health_event('$($ids.pet)','insulin','$occurredB','$($ids.occurrence)','{"synthetic_test":"phase21"}'::jsonb,null,'$($ids.keyB)'::uuid,'Asia/Seoul',null);
commit;
"@
  $procA = Start-PsqlSession $sessionA
  Start-Sleep -Milliseconds 600
  $procB = Start-PsqlSession $sessionB
  $waitEvidence = $false
  for ($i = 0; $i -lt 30; $i++) {
    $wait = Invoke-Psql "select count(*) from pg_stat_activity where application_name='$appB' and state='active' and wait_event_type='Lock' and wait_event='advisory';"
    if ($wait.Stdout -eq '1') { $waitEvidence = $true; break }
    Start-Sleep -Milliseconds 150
  }
  Assert $waitEvidence 'independent caregiver B PostgreSQL backend was observed waiting on the same occurrence advisory lock while caregiver A held it'

  $procA.Process.WaitForExit()
  $procB.Process.WaitForExit()
  $outA = $procA.Stdout.Result.Trim()
  $outB = $procB.Stdout.Result.Trim()
  if ($procA.Process.ExitCode -ne 0) { throw "Session A failed: $($procA.Stderr.Result) $outA" }
  if ($procB.Process.ExitCode -ne 0) { throw "Session B failed: $($procB.Stderr.Result) $outB" }
  $procA.Process.Dispose(); $procB.Process.Dispose()
  Write-Output "SESSION_A_OUTPUT=$outA"
  Write-Output "SESSION_B_OUTPUT=$outB"
  Assert ($outA -match 'A_LOCK\|\d+\|') 'session A logged its distinct PostgreSQL backend PID and lock start time'
  Assert ($outB -match 'B_RPC\|\d+\|') 'session B logged its distinct PostgreSQL backend PID and RPC start time'
  $pidA = [regex]::Match($outA, 'A_LOCK\|(?<pid>\d+)\|').Groups['pid'].Value
  $pidB = [regex]::Match($outB, 'B_RPC\|(?<pid>\d+)\|').Groups['pid'].Value
  Assert ($pidA -and $pidB -and $pidA -ne $pidB) 'two requests used different PostgreSQL backend sessions'
  Assert ($outB -match 'DUPLICATE_POSSIBLE') 'the second concurrent insulin event returned a duplicate possibility warning'

  $check = Invoke-Psql @"
select (select count(*) from public.health_events where pet_id='$($ids.pet)' and occurrence_id='$($ids.occurrence)') || '|' ||
 (select count(*) from public.health_events where pet_id='$($ids.pet)' and occurrence_id='$($ids.occurrence)' and occurred_at in ('$occurredA'::timestamptz,'$occurredB'::timestamptz)) || '|' ||
 (select count(*) from public.audit_log where actor_id in ('$($ids.userA)','$($ids.userB)') and action='HEALTH_EVENT_RECORDED' and request_id in ('$($ids.keyA)','$($ids.keyB)')) || '|' ||
 (select count(*) from public.safety_evaluations where pet_id='$($ids.pet)' and occurrence_id='$($ids.occurrence)');
"@
  Assert ($check.Stdout -eq '2|2|2|2') 'both occurred_at values, events, audit entries, and Safety Evaluations were preserved'

  $retry = Invoke-Psql @"
set role authenticated;
select set_config('request.jwt.claims','{"sub":"$($ids.userA)","role":"authenticated"}',false);
select public.record_health_event('$($ids.pet)','insulin','$occurredA','$($ids.occurrence)','{"synthetic_test":"phase21"}'::jsonb,null,'$($ids.keyA)'::uuid,'Asia/Seoul',null)->>'event_id';
"@
  $eventA = [regex]::Match($outA, '"event_id"\s*:\s*"(?<id>[^"]+)').Groups['id'].Value
  $retryEvent = ($retry.Stdout -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f-]{36}$' } | Select-Object -Last 1)
  Assert ($retryEvent -eq $eventA) 'retry with the same actor, payload, and idempotency key returned the original event'
  $countAfterRetry = Invoke-Psql "select count(*) from public.health_events where pet_id='$($ids.pet)' and occurrence_id='$($ids.occurrence)';"
  Assert ($countAfterRetry.Stdout -eq '2') 'idempotent retry did not insert a third event'

  Invoke-Psql "update public.pet_access_grants set status='REVOKED',revoked_at=now() where pet_id='$($ids.pet)' and user_id='$($ids.userB)' and status='ACTIVE';" | Out-Null
  $revoked = Invoke-Psql @"
set role authenticated;
select set_config('request.jwt.claims','{"sub":"$($ids.userB)","role":"authenticated"}',false);
select public.record_health_event('$($ids.pet)','meal',now(),null,'{"synthetic_test":"revoked"}'::jsonb,null,'$($ids.retryKey)'::uuid,'Asia/Seoul',null);
"@ -AllowFailure
  Assert ($revoked.ExitCode -ne 0 -and $revoked.Stderr -match 'FORBIDDEN') 'revoked caregiver write was rejected by the server'
  $revokedRead = Invoke-Psql @"
set role authenticated;
select set_config('request.jwt.claims','{"sub":"$($ids.userB)","role":"authenticated"}',false);
select (select count(*) from public.pets where id='$($ids.pet)') || '|' || (select count(*) from public.health_events where pet_id='$($ids.pet)');
"@
  $readResult = ($revokedRead.Stdout -split "`r?`n" | Where-Object { $_ -match '^\d+\|\d+$' } | Select-Object -Last 1)
  Assert ($readResult -eq '0|0') 'revoked caregiver could not read the Pet or its events through RLS'
  $afterRevoke = Invoke-Psql "select count(*) from public.health_events where pet_id='$($ids.pet)';"
  Assert ($afterRevoke.Stdout -eq '2') 'revoked caregiver request created no event'
  Write-Output 'CONCURRENCY_REGRESSION=PASS'
}
finally {
  if ($created) {
    $cleanup = @"
begin;
delete from public.audit_log where actor_id in ('$($ids.userA)','$($ids.userB)') and (request_id in ('$($ids.keyA)','$($ids.keyB)','$($ids.retryKey)') or target_id in ('$($ids.household)','$($ids.pet)'));
delete from public.health_event_revisions where event_id in (select id from public.health_events where pet_id='$($ids.pet)');
delete from public.safety_evaluations where pet_id='$($ids.pet)';
delete from public.idempotency_records where actor_id in ('$($ids.userA)','$($ids.userB)');
delete from public.health_events where pet_id='$($ids.pet)';
delete from public.routine_occurrences where pet_id='$($ids.pet)';
delete from public.care_routine_versions where pet_id='$($ids.pet)';
delete from public.care_routines where pet_id='$($ids.pet)';
delete from public.care_plan_versions where pet_id='$($ids.pet)';
delete from public.care_plans where pet_id='$($ids.pet)';
delete from public.pet_access_grants where pet_id='$($ids.pet)';
delete from public.household_memberships where household_id='$($ids.household)';
delete from public.pets where id='$($ids.pet)';
delete from public.households where id='$($ids.household)';
delete from auth.users where id in ('$($ids.userA)','$($ids.userB)');
commit;
"@
    Invoke-Psql $cleanup | Out-Null
    Write-Output 'TEST_FIXTURE_CLEANUP=PASS (only this run synthetic IDs)'
  }
}
