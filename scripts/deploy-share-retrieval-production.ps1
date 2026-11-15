param([ValidateSet('Preflight','DryRun','ApplyMigration','DeployFunction')][string]$Stage = 'Preflight')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/production-credential-helper.ps1"
$projectRef = 'lfbcxtaqpnbvxpsoywtg'
$projectUrl = "https://api.supabase.com/v1/projects/$projectRef"
$cli = Join-Path $PSScriptRoot '../node_modules/supabase/dist/supabase.js'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$work = [IO.Path]::GetFullPath((Join-Path $repo '.tmp/share-retrieval-production-20261115'))
if (-not $work.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Workspace path mismatch' }
try {
  $token = [HaniLogCliCredential]::Load()
  $headers = @{ Authorization = "Bearer $token" }
  $project = Invoke-RestMethod $projectUrl -Headers $headers -TimeoutSec 30
  if ($project.name -ne 'hanilog-production' -or $project.region -ne 'ap-northeast-2') { throw 'Production target mismatch' }
  $query = "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='glucose_share_links' and column_name='share_token_ciphertext') as applied;"
  $result = Invoke-RestMethod "$projectUrl/database/query/read-only" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{ query = $query } | ConvertTo-Json -Compress) -TimeoutSec 30
  $row = if ($result -is [array]) { $result[0] } elseif ($result.value) { $result.value[0] } else { $result }
  Write-Output "Production verified; migration applied=$($row.applied)"
  if ($Stage -eq 'Preflight') { return }
  $env:SUPABASE_ACCESS_TOKEN = $token
  $env:SUPABASE_TELEMETRY_DISABLED = '1'
  if ($Stage -eq 'DryRun' -or $Stage -eq 'ApplyMigration') {
    if ($row.applied -eq $true) { Write-Output 'Migration already applied'; return }
    $ErrorActionPreference = 'Continue'
    $cliConnection = & node $cli db dump --project-ref $projectRef --dry-run 2>&1
    $cliExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($cliExit -ne 0) { throw 'CLI database authentication failed' }
    $connection = @{}
    foreach ($line in $cliConnection) {
      if ($line -match '^export (PGHOST|PGPORT|PGUSER|PGDATABASE|PGPASSWORD)="([^"\r\n]*)"$') { $connection[$Matches[1]] = $Matches[2] }
    }
    if ($connection.PGHOST -ne 'aws-0-ap-northeast-2.pooler.supabase.com' -or $connection.PGPORT -ne '5432' -or
        $connection.PGUSER -ne "cli_login_postgres.$projectRef" -or $connection.PGDATABASE -ne 'postgres' -or -not $connection.PGPASSWORD) {
      throw 'CLI database target mismatch'
    }
    $encodedPassword = [Uri]::EscapeDataString($connection.PGPASSWORD)
    $dbUrl = "postgresql://$($connection.PGUSER):${encodedPassword}@$($connection.PGHOST):$($connection.PGPORT)/postgres?sslmode=require"
    $cliConnection = $null
    New-Item -ItemType Directory -Path (Join-Path $work 'supabase/migrations') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'supabase/config.toml') -Destination (Join-Path $work 'supabase/config.toml')
    $tracked = & git -C $repo ls-files -- 'supabase/migrations'
    if ($LASTEXITCODE -ne 0 -or @($tracked).Count -lt 20) { throw 'Tracked migration inventory unavailable' }
    foreach ($relative in $tracked) {
      Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination (Join-Path $work 'supabase/migrations')
    }
    Copy-Item -LiteralPath (Join-Path $repo 'supabase/migrations/202611150001_glucose_share_retrieval.sql') -Destination (Join-Path $work 'supabase/migrations')
    & node $cli db push --db-url $dbUrl --workdir $work --skip-vault --dry-run --yes
    if ($LASTEXITCODE -ne 0) { throw 'Migration dry-run failed' }
    if ($Stage -eq 'DryRun') { return }
    & node $cli db push --db-url $dbUrl --workdir $work --skip-vault --yes
    if ($LASTEXITCODE -ne 0) { throw 'Migration apply failed' }
    Write-Output 'Share retrieval migration applied'
  }
  if ($Stage -eq 'DeployFunction') {
    if ($row.applied -ne $true) { throw 'Migration must be applied first' }
    & node $cli functions deploy glucose-share --project-ref $projectRef --workdir $repo
    if ($LASTEXITCODE -ne 0) { throw 'Function deploy failed' }
    Write-Output 'glucose-share function deployed'
  }
} finally {
  Remove-Item Env:SUPABASE_ACCESS_TOKEN,Env:SUPABASE_DB_PASSWORD,Env:SUPABASE_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
  $token = $null; $headers = $null; $credential = $null; $dbUrl = $null; $connection = $null
}
