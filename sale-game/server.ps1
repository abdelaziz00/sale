<#
  FUT Market Radar — local backend (Windows PowerShell 5.1+, no installs needed).

  * Serves the dashboard from ./public
  * GET  /api/market            merged, rate-limited data from enabled sources
  * GET  /api/market?fixture=X  TEST FIXTURE data for QA (ok|empty|stale|fail|slow|malformed)
  * POST /api/log               append one price observation to data/price-log.json
  * GET  /api/health

  The browser polls /api/market every 5 s; upstream sources are only contacted
  when their minIntervalSec has elapsed (floor 30 s for remote sources), with
  exponential backoff on errors and Retry-After honoured on HTTP 429.
#>
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
if ($Port -eq 0) { $Port = [int]$Config.port }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$State = @{}
foreach ($s in $Config.sources) {
  $State[$s.id] = @{ lastAttempt = $null; lastSuccess = $null; dataAsOf = $null; payload = $null
                     status = 'pending'; message = ''; failures = 0; nextAllowed = [datetime]::MinValue; fetches = 0 }
}
$FixtureNames = @('ok', 'empty', 'stale', 'fail', 'slow', 'malformed')

function Get-Iso($d) { if ($d) { $d.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null } }

function Update-Source($s) {
  $st = $State[$s.id]
  $now = [datetime]::UtcNow
  if (-not $s.enabled) { $st.status = 'disabled'; $st.message = $s.disabledReason; return }
  if ($now -lt $st.nextAllowed) { return }   # rate limit: serve cached copy

  $minInterval = [double]$s.minIntervalSec
  if ($s.type -eq 'http' -and $minInterval -lt 30) { $minInterval = 30 }
  $st.lastAttempt = $now
  try {
    if ($s.type -eq 'file') {
      $p = Join-Path $Root $s.path
      if (-not (Test-Path $p)) {
        $st.payload = $null; $st.status = 'empty'
        $st.message = 'No observations logged yet. Use "Log a price" to record prices you see on FUT.GG / FUTBIN.'
        $st.nextAllowed = $now.AddSeconds($minInterval); return
      }
      $mtime = (Get-Item $p).LastWriteTimeUtc
      if ($st.payload -and $st.dataAsOf -eq $mtime) { $st.nextAllowed = $now.AddSeconds($minInterval); return }
      $raw = [IO.File]::ReadAllText($p, $Utf8)
      $null = $raw | ConvertFrom-Json
      $st.payload = $raw; $st.dataAsOf = $mtime
    }
    elseif ($s.type -eq 'http') {
      if (-not $s.endpoint) { throw 'No endpoint configured.' }
      $headers = @{ 'Accept' = 'application/json'; 'User-Agent' = 'FUT-Market-Radar/1.0 (personal dashboard)' }
      if ($s.apiKeyEnv) {
        $key = [Environment]::GetEnvironmentVariable($s.apiKeyEnv)
        if ($key) { $headers[$s.apiKeyHeader] = $key }
      }
      $st.fetches++
      $r = Invoke-WebRequest -Uri $s.endpoint -Headers $headers -TimeoutSec 8 -UseBasicParsing
      $raw = [string]$r.Content
      $null = $raw | ConvertFrom-Json
      $st.payload = $raw; $st.dataAsOf = $now
    }
    $st.lastSuccess = $now; $st.failures = 0; $st.status = 'ok'; $st.message = ''
    $st.nextAllowed = $now.AddSeconds($minInterval)
  }
  catch {
    $st.failures++
    $backoff = [math]::Min(600, $minInterval * [math]::Pow(2, $st.failures - 1))
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 429) {
      $ra = 0
      if ([int]::TryParse([string]$resp.Headers['Retry-After'], [ref]$ra)) { $backoff = [math]::Max($backoff, $ra) }
    }
    $st.nextAllowed = $now.AddSeconds($backoff)
    $st.status = 'error'
    $st.message = "$($_.Exception.Message) Next attempt in $([int]$backoff)s." + $(if ($st.payload) { ' Showing last good data.' } else { '' })
  }
}

function Get-SourceJson($meta, [string]$payload) {
  $json = ConvertTo-Json -InputObject $meta -Compress
  if (-not $payload) { $payload = 'null' }
  return $json.Substring(0, $json.Length - 1) + ',"payload":' + $payload + '}'
}

function Get-MarketJson() {
  $now = [datetime]::UtcNow
  $parts = @()
  foreach ($s in $Config.sources) {
    Update-Source $s
    $st = $State[$s.id]
    $status = $st.status
    if ($status -eq 'ok' -and $s.type -eq 'http' -and $st.dataAsOf -and ($now - $st.dataAsOf).TotalSeconds -gt $Config.staleAfterSec) { $status = 'stale' }
    $meta = [ordered]@{
      id = $s.id; name = $s.name; type = $s.type; enabled = [bool]$s.enabled; status = $status; message = $st.message
      lastAttempt = (Get-Iso $st.lastAttempt); lastSuccess = (Get-Iso $st.lastSuccess); dataAsOf = (Get-Iso $st.dataAsOf)
      nextFetch = $(if ($st.nextAllowed -gt [datetime]::MinValue) { Get-Iso $st.nextAllowed } else { $null }); upstreamFetches = $st.fetches
    }
    $parts += (Get-SourceJson $meta $st.payload)
  }
  $version = ($Config.sources | ForEach-Object { $st = $State[$_.id]; "$($_.id):$($st.status):$(Get-Iso $st.dataAsOf)" }) -join '|'
  return '{"mode":"live","generatedAt":"' + (Get-Iso $now) + '","version":' + (ConvertTo-Json $version) +
    ',"staleAfterSec":' + $Config.staleAfterSec + ',"events":' + (Get-EventsJson 'data/events.json') + ',"sources":[' + ($parts -join ',') + ']}'
}

function Get-EventsJson($rel) {
  $p = Join-Path $Root $rel
  if (Test-Path $p) { $raw = [IO.File]::ReadAllText($p, $Utf8); try { $null = $raw | ConvertFrom-Json; return $raw } catch { } }
  return '[]'
}

# QA fixtures: clearly-labelled synthetic data with relative timestamps. Never mixed with live data.
function Get-FixtureJson($name) {
  $now = [datetime]::UtcNow
  $file = if ($name -eq 'malformed') { 'malformed.json' } elseif ($name -eq 'empty') { $null } else { 'market.json' }
  $payload = if ($file) { [IO.File]::ReadAllText((Join-Path $Root "tests/fixtures/$file"), $Utf8) } else { '{"players":[]}' }
  $asOf = if ($name -eq 'stale') { $now.AddHours(-3) } else { $now }
  $meta = [ordered]@{
    id = 'fixture'; name = 'Test fixture'; type = 'fixture'; enabled = $true; status = $(if ($name -eq 'stale') { 'stale' } else { 'ok' })
    message = 'Synthetic QA data - not real market prices.'; lastAttempt = (Get-Iso $now); lastSuccess = (Get-Iso $asOf); dataAsOf = (Get-Iso $asOf)
    nextFetch = $null; upstreamFetches = 0
  }
  return '{"mode":"fixture","fixture":"' + $name + '","generatedAt":"' + (Get-Iso $now) + '","version":"fixture-' + $name +
    '","staleAfterSec":' + $Config.staleAfterSec + ',"events":' + (Get-EventsJson 'tests/fixtures/events.json') + ',"sources":[' + (Get-SourceJson $meta $payload) + ']}'
}

function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Add-Observation([string]$body) {
  $o = $body | ConvertFrom-Json
  $name = ([string]$o.name).Trim()
  if ($name.Length -lt 2 -or $name.Length -gt 60) { throw 'Name must be 2-60 characters.' }
  $rating = 0; if (-not [int]::TryParse([string]$o.rating, [ref]$rating) -or $rating -lt 40 -or $rating -gt 99) { throw 'Rating must be 40-99.' }
  $price = 0L; if (-not [long]::TryParse([string]$o.price, [ref]$price) -or $price -lt 150 -or $price -gt 15000000) { throw 'Price must be 150-15,000,000 coins.' }
  $pos = ([string]$o.position).Trim().ToUpper(); if ($pos -notmatch '^[A-Z]{2,3}$') { throw 'Position must be 2-3 letters (e.g. ST, CAM).' }
  $listings = $null
  if ("$($o.listings)" -ne '') { $l = 0; if (-not [int]::TryParse([string]$o.listings, [ref]$l) -or $l -lt 0) { throw 'Listings must be a whole number.' }; $listings = $l }
  foreach ($u in @($o.imageUrl, $o.sourceUrl)) { if ("$u" -ne '' -and "$u" -notmatch '^https://[^\s"<>]+$') { throw 'URLs must start with https://' } }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $t = $nowMs
  if ("$($o.observedAt)" -ne '') {
    $t = [long]$o.observedAt
    if ($t -gt $nowMs + 60000 -or $t -lt $nowMs - 30L * 86400000) { throw 'Observation time must be within the last 30 days.' }
  }

  $path = Join-Path $Root 'data/price-log.json'
  if (Test-Path $path) { $log = [IO.File]::ReadAllText($path, $Utf8) | ConvertFrom-Json } else { $log = [pscustomobject]@{ players = @() } }
  $id = (($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')) + '-' + $rating
  $p = @($log.players) | Where-Object { $_.id -eq $id } | Select-Object -First 1
  if (-not $p) {
    $p = [pscustomobject]@{ id = $id; name = $name; rating = $rating; position = $pos; imageUrl = $null; sourceUrl = $null; price = $price; priceUpdatedAt = $t; history = @(); listings = @() }
    $log.players = @($log.players) + $p
  }
  Set-Prop $p 'position' $pos
  if ("$($o.imageUrl)" -ne '') { Set-Prop $p 'imageUrl' ([string]$o.imageUrl) }
  if ("$($o.sourceUrl)" -ne '') { Set-Prop $p 'sourceUrl' ([string]$o.sourceUrl) }
  Set-Prop $p 'history' (@(@($p.history) | Where-Object { $_ }) + [pscustomobject]@{ t = $t; p = $price })
  if ($null -ne $listings) { Set-Prop $p 'listings' (@(@($p.listings) | Where-Object { $_ }) + [pscustomobject]@{ t = $t; p = $listings }) }
  # Current price = most recent observation.
  $latest = @($p.history) | Sort-Object { [long]$_.t } | Select-Object -Last 1
  Set-Prop $p 'price' ([long]$latest.p); Set-Prop $p 'priceUpdatedAt' ([long]$latest.t)

  $dir = Split-Path $path; if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
  [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $log -Depth 6 -Compress), $Utf8)
  $State['local'].nextAllowed = [datetime]::MinValue
  return (ConvertTo-Json -InputObject ([ordered]@{ ok = $true; id = $id; points = @($p.history).Count }) -Compress)
}

$Mime = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
           '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon' }

function Send($ctx, [int]$code, [string]$ctype, [byte[]]$bytes) {
  $res = $ctx.Response
  $res.StatusCode = $code; $res.ContentType = $ctype
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['X-Content-Type-Options'] = 'nosniff'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.OutputStream.Close()
}
function Send-Json($ctx, [int]$code, [string]$json) { Send $ctx $code 'application/json; charset=utf-8' $Utf8.GetBytes($json) }
function Send-Error($ctx, [int]$code, [string]$msg) { Send-Json $ctx $code (ConvertTo-Json -InputObject @{ error = $msg } -Compress) }

function Send-Static($ctx, [string]$urlPath) {
  $rel = [Uri]::UnescapeDataString($urlPath).TrimStart('/')
  if ($rel -eq '') { $rel = 'index.html' }
  $base = if ($rel.StartsWith('tests/')) { $Root } else { Join-Path $Root 'public' }
  $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
  if (-not $full.StartsWith([IO.Path]::GetFullPath($base)) -or -not (Test-Path $full -PathType Leaf)) { Send-Error $ctx 404 'Not found'; return }
  $ext = [IO.Path]::GetExtension($full).ToLower()
  $type = if ($Mime.ContainsKey($ext)) { $Mime[$ext] } else { 'application/octet-stream' }
  Send $ctx 200 $type ([IO.File]::ReadAllBytes($full))
}

function Invoke-Request($ctx) {
  $req = $ctx.Request
  $path = $req.Url.AbsolutePath
  if ($path -eq '/api/market' -and $req.HttpMethod -eq 'GET') {
    $fx = $req.QueryString['fixture']
    if ($fx) {
      if ($FixtureNames -notcontains $fx) { Send-Error $ctx 400 "Unknown fixture '$fx'."; return }
      if ($fx -eq 'fail') { Send-Error $ctx 503 'Simulated upstream failure (fixture=fail).'; return }
      if ($fx -eq 'slow') { Start-Sleep -Seconds 3 }
      Send-Json $ctx 200 (Get-FixtureJson $fx); return
    }
    Send-Json $ctx 200 (Get-MarketJson); return
  }
  if ($path -eq '/api/log' -and $req.HttpMethod -eq 'POST') {
    # CSRF guard: only same-origin JSON posts.
    $origin = $req.Headers['Origin']
    if ($origin -and $origin -ne "http://localhost:$Port" -and $origin -ne "http://127.0.0.1:$Port") { Send-Error $ctx 403 'Cross-origin request refused.'; return }
    if ("$($req.ContentType)" -notlike 'application/json*') { Send-Error $ctx 415 'Content-Type must be application/json.'; return }
    $reader = New-Object IO.StreamReader($req.InputStream, $Utf8)
    $body = $reader.ReadToEnd(); $reader.Close()
    if ($body.Length -gt 4096) { Send-Error $ctx 413 'Body too large.'; return }
    try { Send-Json $ctx 200 (Add-Observation $body) } catch { Send-Error $ctx 400 $_.Exception.Message }
    return
  }
  if ($path -eq '/api/health') { Send-Json $ctx 200 '{"ok":true}'; return }
  if ($path.StartsWith('/api/')) { Send-Error $ctx 404 'Unknown endpoint'; return }
  if ($req.HttpMethod -ne 'GET') { Send-Error $ctx 405 'Method not allowed'; return }
  Send-Static $ctx $path
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "FUT Market Radar running at http://localhost:$Port/  (Ctrl+C to stop)"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try { Invoke-Request $ctx }
    catch { Write-Warning $_.Exception.Message; try { Send-Error $ctx 500 'Internal error' } catch { } }
  }
}
finally { $listener.Stop() }
