<#
  Generates SYNTHETIC QA fixtures (tests/fixtures/*.json). These are not market
  data: players are named "Fixture Player NN" and the dashboard shows a
  TEST FIXTURE banner whenever they are loaded. Timestamps are millisecond
  offsets relative to the response time ("timeBase": "relative").
#>
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root 'fixtures'
New-Item -ItemType Directory -Force $Out | Out-Null
$rng = New-Object System.Random 27
$HourMs = 3600000
function Noise([double]$sd) { # Box-Muller
  $u1 = 1.0 - $rng.NextDouble(); $u2 = $rng.NextDouble()
  return $sd * [math]::Sqrt(-2 * [math]::Log($u1)) * [math]::Sin(2 * [math]::PI * $u2)
}
function Ladder([double]$p) {
  $step = if ($p -lt 1000) { 50 } elseif ($p -lt 10000) { 100 } elseif ($p -lt 50000) { 250 } elseif ($p -lt 100000) { 500 } else { 1000 }
  return [long]([math]::Max(150, [math]::Round($p / $step) * $step))
}
# regime: drift per hour (log), noise, shape
$specs = @(
  @{ r = 88; pos = 'ST';  base = 42000;  shape = 'up';       noise = 0.006 },
  @{ r = 86; pos = 'CAM'; base = 18500;  shape = 'dip';      noise = 0.008 },
  @{ r = 84; pos = 'CB';  base = 9800;   shape = 'down';     noise = 0.006 },
  @{ r = 83; pos = 'CM';  base = 4300;   shape = 'flat';     noise = 0.010 },
  @{ r = 87; pos = 'LW';  base = 61000;  shape = 'flat';     noise = 0.005 },
  @{ r = 89; pos = 'CDM'; base = 128000; shape = 'volatile'; noise = 0.030 },
  @{ r = 85; pos = 'RB';  base = 7600;   shape = 'up';       noise = 0.004 },
  @{ r = 82; pos = 'GK';  base = 1900;   shape = 'down';     noise = 0.012 },
  @{ r = 90; pos = 'RW';  base = 305000; shape = 'dip';      noise = 0.007 },
  @{ r = 84; pos = 'LB';  base = 3100;   shape = 'squeeze';  noise = 0.006 },
  @{ r = 86; pos = 'CM';  base = 23750;  shape = 'crash';    noise = 0.009 },
  @{ r = 83; pos = 'ST';  base = 2600;   shape = 'short';    noise = 0.010 }
)
$players = @()
$i = 0
foreach ($s in $specs) {
  $i++
  $n = if ($s.shape -eq 'short') { 4 } else { 168 }
  $hist = @(); $list = @()
  $lp = [math]::Log($s.base)
  $listN = 400 + $rng.Next(0, 400)
  for ($k = $n - 1; $k -ge 0; $k--) {
    $h = -$k
    $d = switch ($s.shape) {
      'up'       { 0.0012 }
      'down'     { -0.0011 }
      'dip'      { if ($k -gt 40) { -0.0018 } else { 0.0022 } }
      'squeeze'  { if ($k -gt 48) { 0 } else { 0.0016 } }
      'crash'    { if ($k -gt 20) { 0.0005 } elseif ($k -gt 12) { -0.012 } else { 0.0 } }
      default    { 0 }
    }
    $lp += $d + (Noise $s.noise)
    $hist += , @([long]($h * $HourMs), (Ladder ([math]::Exp($lp))))
    if ($s.shape -eq 'squeeze' -and $k -le 48) { $listN = [math]::Max(40, $listN * 0.975) } else { $listN = [math]::Max(40, $listN * (1 + (Noise 0.02))) }
    if ($k % 3 -eq 0) { $list += , @([long]($h * $HourMs), [int]$listN) }
  }
  $last = $hist[$hist.Count - 1]
  $img = if ($i -eq 2) { '/img/missing-card.png' } else { $null }
  $players += [ordered]@{
    id = ('fixture-{0:D2}' -f $i); name = ('Fixture Player {0:D2}' -f $i); rating = $s.r; position = $s.pos
    imageUrl = $img; sourceUrl = $null; price = $last[1]; priceUpdatedAt = $last[0]; history = $hist; listings = $list
  }
}
$market = [ordered]@{ timeBase = 'relative'; players = $players }
[IO.File]::WriteAllText((Join-Path $Out 'market.json'), (ConvertTo-Json -InputObject $market -Depth 6 -Compress))

$good = $players[0]
$malformed = [ordered]@{ timeBase = 'relative'; players = @(
  $good,
  [ordered]@{ id = 'bad-1'; name = 'Missing Price'; rating = 85; position = 'ST'; history = $good.history },
  [ordered]@{ id = 'bad-2'; name = 'Negative Price'; rating = 85; position = 'ST'; price = -500; history = $good.history },
  [ordered]@{ id = 'bad-3'; name = '<img src=x onerror=alert(1)>'; rating = 85; position = 'ST'; price = 5000; history = 'oops' },
  'not-an-object'
) }
[IO.File]::WriteAllText((Join-Path $Out 'malformed.json'), (ConvertTo-Json -InputObject $malformed -Depth 6 -Compress))

# Fixture event (fictional), starts 10 h after load; offsets resolved client-side.
[IO.File]::WriteAllText((Join-Path $Out 'events.json'), '[{"name":"Fixture Promo","startOffsetH":10,"impactPct":6,"minRating":85}]')
Write-Host "Fixtures written to $Out"
