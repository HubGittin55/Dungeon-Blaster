# probe-uia.ps1 - where does a markdown list item's BODY live in the accessibility tree?
#
# Observed, twice, from the production reader: Stunkus's message comes back as "Must-fix:" then bare "1."
# and "2." with nothing in them, and the token instructions as "1. 2. 3. 4." with nothing in them. The
# markers arrive and the instructions do not. FindAll(Descendants, Text) is already what the reader does, so
# the bodies are under some other control type, or not under the row at all. This dumps one message row's
# entire subtree with control types and full names so the answer is evidence and not another guess.
#
# Read-only. Nothing here can send anything.
#
#   powershell -File probe-uia.ps1                      # auto-find the row containing 'Must-fix'
#   powershell -File probe-uia.ps1 -Find 'fine-grained'  # any other suspect row
param(
  [string]$Find = 'Must-fix',
  [string]$Match = 'Stunkus',
  [int]$Max = 200
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$SD = [System.Windows.Automation.TreeScope]::Descendants
$SC = [System.Windows.Automation.TreeScope]::Children
function Cond($p, $v) { New-Object System.Windows.Automation.PropertyCondition($p, $v) }
function Trunc($s, $n) { $s = "$s" -replace "`r|`n", ' '; if ($s.Length -gt $n) { return $s.Substring(0, $n) + '…' } return $s }

$target = $null
foreach ($p in (Get-Process firefox -ErrorAction SilentlyContinue)) {
  $win = $AE::RootElement.FindFirst($SC, (Cond $AE::ProcessIdProperty $p.Id))
  if (-not $win) { continue }
  foreach ($d in $win.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Document))) {
    if ($d.Current.Name -notmatch $Match) { continue }
    foreach ($g in $win.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Group))) {
      if ($g.Current.Name -eq 'Chat messages') { $script:target = [ordered]@{ win = $win; doc = $d; msgs = $g } }
    }
  }
  if ($script:target) { break }
}
if (-not $script:target) { Write-Output 'no target'; exit 1 }
$t = $script:target
Write-Output "win='$($t.win.Current.Name)'"

$rows = @($t.msgs.FindAll($SC, (Cond $AE::ControlTypeProperty $CT::Group)))
Write-Output "rows=$($rows.Count)  looking for /$Find/"

# Does the string exist ANYWHERE in the document, and under what control type? That separates "the DOM does
# not have it" from "the row does not contain it" - two different bugs with two different fixes.
$needle = $Find
$every = @($t.doc.FindAll($SD, [System.Windows.Automation.Condition]::TrueCondition))
Write-Output "document elements: $($every.Count)"
foreach ($e in $every) {
  $n = [string]$e.Current.Name
  if ($n -notmatch [regex]::Escape($needle)) { continue }
  $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  $r = $e.Current.BoundingRectangle
  Write-Output ("  HIT {0,-11} class={1,-22} rect={2}x{3} :: {4}" -f $ct, $e.Current.ClassName, [int]$r.Width, [int]$r.Height, (Trunc $n 150))
}

$row = $null
foreach ($r in $rows) { if (([string]$r.Current.Name) -match [regex]::Escape($needle)) { $row = $r; break } }
if (-not $row) { Write-Output 'row not found'; exit 1 }

Write-Output ''
Write-Output '=== the row itself ==='
Write-Output "control=$($row.Current.ControlType.ProgrammaticName) class=$($row.Current.ClassName)"
Write-Output ("row.Name ({0}c): {1}" -f ([string]$row.Current.Name).Length, (Trunc ([string]$row.Current.Name) 700))

Write-Output ''
Write-Output '=== every descendant of the row, control type by control type ==='
$i = 0
foreach ($k in $row.FindAll($SD, [System.Windows.Automation.Condition]::TrueCondition)) {
  $ct = $k.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
  $n = [string]$k.Current.Name
  $r = $k.Current.BoundingRectangle
  $zero = if ($r.Width -le 0 -or $r.Height -le 0) { 'ZERO' } else { '    ' }
  Write-Output ("[{0,3}] {1,-11} {2} class={3,-20} {4}" -f $i, $ct, $zero, $k.Current.ClassName, (Trunc $n 190))
  $i++
  if ($i -ge $Max) { Write-Output "  (stopped at $Max)"; break }
}
