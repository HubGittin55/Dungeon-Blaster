<#
  stunkus.ps1 - the only component of code-bridge with hands on the desktop.

  Reads and writes ONE document: the Muse/Stunkus chat in a Firefox tab, located through Windows UI
  Automation. Never enumerates another tab, never captures outside the browser window rect, never sends
  without verifying that the keystrokes landed.

  verbs:  status | peek [N] | read | copy [N] | send [--expect-reply] | shot | pause | resume
  input:  message text arrives on stdin or --text-file, because PowerShell 5.1 argument encoding eats the
          em dashes this machine's own window titles are made of.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Verb = 'status',
  [Parameter(Position = 1)][string]$Arg1 = '',
  [string]$TextFile = '',
  # The extension passes this for every PI: answer so a turn is never answered twice. It used to have no
  # matching parameter here, which made PowerShell abort the send before a single key was pressed - i.e. every
  # reply that named the turn it answered failed. It is recorded on the outbound journal line for audit;
  # quoting in the Muse thread is not wired (no reliable per-message reply affordance), so nothing else reads it.
  [string]$InReplyTo = '',
  [switch]$ExpectReply,
  [switch]$NoPrefix,
  [switch]$AllowSecrets,
  [switch]$PiOnly,
  [string]$Role = '',
  [switch]$Force,
  [int]$TimeoutSec = 90,
  [string]$Match = $env:DB_MUSE_MATCH,
  [string]$Root = '',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not $Match) { $Match = 'Stunkus' }
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Journal = Join-Path $Root 'journal'
$Shots = Join-Path $Journal 'shots'
$StatePath = Join-Path $Journal 'state.json'
$LogPath = Join-Path $Journal 'messages.jsonl'
$PausePath = Join-Path $Journal 'PAUSE'
New-Item -ItemType Directory -Force -Path $Shots | Out-Null

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -Namespace Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(System.IntPtr h, System.IntPtr hdc, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
'@ -Name Win32
[Native.Win32]::SetProcessDPIAware() | Out-Null

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$SP = [System.Windows.Automation.TreeScope]::Parent
$SD = [System.Windows.Automation.TreeScope]::Descendants
$SC = [System.Windows.Automation.TreeScope]::Children
$actionButtons = @('React', 'Reply', 'More options', 'Copy response', 'Copy', 'Thumbs up', 'Thumbs down')

function Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Hash12($s) { ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$s")))).Replace('-', '').Substring(0, 12) }

# Grid-sample the luma of a bitmap: cheap way to tell "captured a page" from "captured a black frame".
function Get-Luma($bmp) {
  $n = 0; $sum = 0.0
  for ($x = 3; $x -lt $bmp.Width; $x += 83) {
    for ($y = 3; $y -lt $bmp.Height; $y += 79) {
      $c = $bmp.GetPixel($x, $y)
      $sum += ([int]$c.R + [int]$c.G + [int]$c.B) / 3.0
      $n++
    }
  }
  return ($sum / [Math]::Max(1, $n))
}

# --- locating the one allowed surface ---------------------------------------------------------------
function Find-Target {
  $out = [ordered]@{ ok = $false; hwnd = 0; pid = 0; title = ''; doc = ''; rect = ''; edit = $null; msgs = $null; note = '' }
  foreach ($p in (Get-Process firefox -ErrorAction SilentlyContinue)) {
    $win = $AE::RootElement.FindFirst($SC, (Cond $AE::ProcessIdProperty $p.Id))
    if (-not $win) { continue }
    $docs = $win.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Document))
    foreach ($d in $docs) {
      # The ONLY gate into page content: a document whose name matches the agreed pattern. Sibling tabs are
      # never returned, so nothing downstream can accidentally read your GitHub session.
      if ($d.Current.Name -notmatch $Match) { continue }
      $msgs = $null
      foreach ($g in $win.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Group))) {
        if ($g.Current.Name -eq 'Chat messages') { $msgs = $g; break }
      }
      $edit = $null
      foreach ($e in $win.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Edit))) {
        if ($e.Current.Name -eq 'Message' -or $e.Current.ClassName -match 'field-sizing-fixed') { $edit = $e; break }
      }
      $r = $win.Current.BoundingRectangle
      $out.ok = $true; $out.hwnd = $win.Current.NativeWindowHandle; $out.pid = $p.Id
      $out.title = $win.Current.Name; $out.doc = $d.Current.Name
      $out.rect = "$([int]$r.X),$([int]$r.Y),$([int]$r.Width),$([int]$r.Height)"
      $out.edit = $edit; $out.msgs = $msgs
      if (-not $msgs) { $out.note = 'no Chat messages group - is a thread open?' }
      return [pscustomobject]$out
    }
    $out.note = "firefox pid $($p.Id) has no document matching /$Match/"
  }
  if (-not $out.note) { $out.note = 'no firefox window found' }
  [pscustomobject]$out
}

# --- transcript parsing -----------------------------------------------------------------------------
# Every message is ONE Text node whose accessible name is "User message: ..." or "Assistant message: ..."
# (measured: 16 user + 17 assistant nodes, one each, in document order). The other ~179 Text nodes are the
# inline spans of those messages - bold, code, timestamps - which is why run-concatenation merged two
# turns and duplicated another. Read the named nodes, ignore the runs.
$RolePattern = '^(?<role>User|Assistant)\s+message:\s*(?<text>[\s\S]*)$'
function Strip-Tag([string]$x) { return ("$x" -replace '^\s*\[Qwenny via Pi\]\s*', '') }

function Read-Transcript($t, $take) {
  # One row under "Chat messages" is one message bubble, paragraphs and all (measured: his 3-paragraph reply
  # is a single row of 6 Text nodes; the PI: test is a row of 2). So group by row - walking Text nodes one by
  # one fragmented messages and made the "is this ours?" flag leak across turns.
  #
  # Identity, stated as the app gives it, after two corrections:
  #   "Assistant message: ..." is STUNKUS and "User message: ..." is BLARMO - the labels are the app's own, so
  #     Assistant does not mean us. Version 1 had that backwards.
  #   Our turns carry no label: the handshake tag arrives as a chip node next to the body, or fused with it.
  #   New messages sometimes carry no label at all and the container reports an empty rect, so neither label
  #     nor geometry is a reliable witness. The tag is: only our sends carry it, and "never answer your own
  #     message" is the one rule that must not depend on guesswork.
  if (-not $t.msgs) { return @() }
  $rows = @($t.msgs.FindAll($SC, (Cond $AE::ControlTypeProperty $CT::Group)))
  if (-not $rows.Count) { return @() }
  $out = @()
  foreach ($row in $rows) {
    $names = @($row.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Text)) | ForEach-Object { ([string]$_.Current.Name).Trim() } | Where-Object { $_ -ne '' })
    $names = @($names | Where-Object { $_ -notmatch '^(You|Stunkus|Blarmo):$' -and $_ -notmatch '^\d{1,2}:\d{2}(:\d{2})?\s*([AP]M|am|pm)?$' -and $_ -notmatch '^[A-Z][a-z]{2} \d{1,2}$' })
    if (-not $names.Count) { continue }
    if (-not $names.Count) { continue }

    # Only the FIRST node counts as the sender chip. He later quoted "[Qwenny via Pi]" inside a sentence and
    # the inline code span arrives as its own Text node - matching it anywhere in the row claimed his message
    # for us, which is the one mistake this loop must never make.
    $head = $names[0]
    if ($head -match '^\s*\[Qwenny via Pi\]') {
      $role = 'me'
      $body = (Strip-Tag ($names -join "`n`n"))
    } else {
      if ($head -like 'Assistant message*') { $role = 'stunkus'; $body = (@($names | ForEach-Object { $_ -replace '^Assistant message:\s*', '' })) -join "`n`n" }
      elseif ($head -like 'User message*') { $role = 'blarmo'; $body = (@($names | ForEach-Object { $_ -replace '^User message:\s*', '' })) -join "`n`n" }
      else { $role = 'peer'; $body = $names -join "`n`n" }
    }
    if ([string]::IsNullOrWhiteSpace($body)) { continue }
    $body = $body.Trim()
    $out += [ordered]@{ role = $role; text = $body; hash = (Hash12 $body); chars = $body.Length }
  }
  if ($take -gt 0 -and $out.Count -gt $take) { $out = @($out | Select-Object -Last $take) }
  return $out
}

function Get-State {
  if (Test-Path $StatePath) { return Get-Content $StatePath -Raw | ConvertFrom-Json }
  [pscustomobject]@{ sent = @(); last_hash = ''; polls = 0; paused_since = '' }
}
function Set-State($s) { ($s | ConvertTo-Json -Depth 5 -Compress) | Set-Content -Path $StatePath -Encoding UTF8 }
function Log-Line($obj) {
  ($obj + [ordered]@{ at = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffK') }) | ConvertTo-Json -Depth 6 -Compress |
    Add-Content -Path $LogPath -Encoding UTF8
}

# --- outbound safety net ----------------------------------------------------------------------------
$SecretPatterns = [ordered]@{
  'key=value secret' = '(?i)(api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key)"?\s*[:=]\s*"?[^\s",}]{6,}'
  'json key field'   = '"(?i)(api[_-]?key|apikey|access[_-]?token|client[_-]?secret|secret|token|password|passwd)"\s*:\s*"[^"]{6,}"'
  'provider token'   = '\b(sk|ghp|gho|ghu|ghs|ghr|hf|xox[abprs]|db)-?[A-Za-z0-9]{12,}'
  'aws key id'       = '\bAKIA[0-9A-Z]{16}\b'
  'private key'      = 'BEGIN [A-Z ]*PRIVATE KEY'
  'bearer'           = '(?i)bearer\s+[A-Za-z0-9._\-]{16,}'
  'blob'             = '[A-Za-z0-9+/]{160,}={0,2}'
  'ipv4 literal'     = '\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b'
}
function Find-Secrets([string]$text) {
  $hits = @()
  foreach ($k in $SecretPatterns.Keys) { if ($text -match $SecretPatterns[$k]) { $hits += $k } }
  return $hits
}
# Redaction runs on the way IN as well as OUT. A chat transcript is a document people paste things into,
# and this one already contains a live API key: reading it must not copy the key into a journal file.
function Mask-Secrets([string]$text) {
  $hits = @()
  foreach ($k in $SecretPatterns.Keys) {
    if ([regex]::IsMatch($text, $SecretPatterns[$k])) {
      $hits += $k
      $text = [regex]::Replace($text, $SecretPatterns[$k], "[secret:$k]")
    }
  }
  return [pscustomobject]@{ text = $text; hits = $hits }
}

# --- input helpers ---------------------------------------------------------------------------------
function Set-Foreground($hwnd) {
  if ($hwnd -eq 0) { return }
  [Native.Win32]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
  Start-Sleep -Milliseconds 150
}
function Read-EditValue($edit) {
  $vp = $null
  if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return [string]$vp.Current.Value }
  return $null
}
function Set-EditValue($edit, [string]$text) {
  $vp = $null
  if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    try { $vp.SetValue($text); return $true } catch { return $false }
  }
  return $false
}
function Paste-IntoEdit($text) {
  # Clipboard is restored afterwards: the bridge must not leave your pasteboard holding a message.
  $old = $null
  try { $old = Get-Clipboard -ErrorAction SilentlyContinue } catch { }
  Set-Clipboard -Value $text
  Start-Sleep -Milliseconds 60
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 40
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 120
  if ($null -ne $old) { try { Set-Clipboard -Value $old } catch { } }
}

# --- verbs -----------------------------------------------------------------------------------------
$target = $null
if ($Verb -notin @('pause', 'resume')) {
  $target = Find-Target
  if (-not $target.ok -and $Verb -ne 'status') { Write-Output "BRIDGE_DOWN: $($target.note)"; exit 3 }
}

switch ($Verb) {
  'status' {
    $s = Get-State
    $busy = $false
    if ($target -and $target.ok -and $target.msgs) {
      foreach ($e in $target.msgs.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Button))) {
        if ($e.Current.Name -match 'Stop|Cancel' -and -not $e.Current.IsOffscreen) { $busy = $true; break }
      }
    }
    $editVal = $null
    if ($target -and $target.edit) { $editVal = Read-EditValue $target.edit }
    $o = [ordered]@{
      ok = [bool]($target -and $target.ok); pid = $target.pid; title = $target.title; doc = $target.doc
      rect = $target.rect; note = $target.note; busy = $busy
      composer_has_text = [bool]($editVal); composer_len = "$($editVal)".Length
      paused = (Test-Path $PausePath); sent_last_hour = @($s.sent | Where-Object { (Get-Date) - [DateTime]$_.ToString() -lt [TimeSpan]::FromHours(1) }).Count
      last_seen_hash = $s.last_hash
      # @($null).Count is 1 in PowerShell, so a missing key used to report one answered message out of thin air.
      replied_count = @($s.replied | Where-Object { $_ -cmatch '^[0-9A-F]{12}$' }).Count
      replied_tail = ((@($s.replied | Where-Object { $_ }) | Select-Object -Last 3) -join ',')
      focus_ok = ($target.ok -and [int64][Native.Win32]::GetForegroundWindow() -eq [int64]$target.hwnd)
    }
    if ($Json) { $o | ConvertTo-Json -Compress } else { $o.GetEnumerator() | ForEach-Object { '{0,-18} {1}' -f $_.Key, $_.Value } }
    break
  }

  'peek' {
    $n = if ($Arg1) { [int]$Arg1 } else { 6 }
    $msgs = Read-Transcript $target $n
    if ($Role) { $msgs = @($msgs | Where-Object { $_.role -eq $Role }) }
    # The PI: protocol: only turns he opens with PI: are answerable, and never one of ours.
    # -cmatch, not -match: PowerShell's -match is case-insensitive, and this keyword is the literal `PI:`. The previous
    # pattern also carried a stray backspace byte where a word-boundary escape belongs, so it matched nothing at all and --PiOnly
    # silently returned an empty transcript. Silence is why nobody noticed for two sessions.
    if ($PiOnly) { $msgs = @($msgs | Where-Object { $_.role -ne 'me' -and $_.text -cmatch '^\s*PI:' }) }
    if ($Role)    { $msgs = @($msgs | Where-Object { $_.role -eq $Role }) }
    $out = @()
    foreach ($m in $msgs) {
      $mask = if ($AllowSecrets) { [pscustomobject]@{ text = $m.text; hits = @() } } else { Mask-Secrets $m.text }
      $out += [ordered]@{ role = $m.role; hash = $m.hash; chars = $m.chars; masked = (@($mask.hits).Count -gt 0); text = $mask.text }
      Log-Line ([ordered]@{ dir = 'in'; hash = $m.hash; chars = $m.chars; masked = (@($mask.hits).Count -gt 0) })
    }
    ConvertTo-Json $out -Depth 4
    break
  }

  'copy' {
    # Invoke the nth-from-last "Copy response" and return the clipboard: exact markdown, no run-splitting.
    $n = if ($Arg1) { [int]$Arg1 } else { 0 }
    $btns = @($target.msgs.FindAll($SD, (Cond $AE::ControlTypeProperty $CT::Button)) | Where-Object { $_.Current.Name -in @('Copy response', 'Copy') })
    if (-not $btns.Count) { Write-Output 'NO_COPY_BUTTON'; break }
    if ($n -ge $btns.Count) { Write-Output "ONLY $($btns.Count) copy buttons"; break }
    $pick = $btns[$btns.Count - 1 - $n]
    $clipBefore = ''
    try { $clipBefore = Get-Clipboard -ErrorAction SilentlyContinue } catch { }
    Set-Clipboard -Value '__bridge_clip_sentinel__'
    $ip = $null
    if (-not $pick.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip)) { Write-Output 'NO_INVOKE_PATTERN'; break }
    $ip.Invoke()
    $got = $null
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 80
      $c = ''
      try { $c = Get-Clipboard -ErrorAction SilentlyContinue } catch { }
      if ($c -and $c -ne '__bridge_clip_sentinel__' -and "$c" -ne "$clipBefore") { $got = $c; break }
      if ($c -and $c -ne '__bridge_clip_sentinel__') { $got = $c; break }
    }
    if ($null -ne $clipBefore -and "$clipBefore" -ne '') { try { Set-Clipboard -Value $clipBefore } catch { } }
    if (-not $got) { Write-Output 'COPY_TIMED_OUT'; break }
    Log-Line ([ordered]@{ dir = 'read-exact'; hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$got")))).Replace('-', '').Substring(0, 12); chars = "$got".Length })
    Write-Output $got
    break
  }

  'send' {
    if (Test-Path $PausePath) { Write-Output 'PAUSED: delete journal/PAUSE to send again'; exit 4 }
    # Reading works through a lock (UIA + PrintWindow). Typing does not: SendInput to a background window is
    # refused on the secure desktop. Say so before touching the clipboard, instead of failing as a mystery.
    if ([Native.Win32]::GetForegroundWindow() -eq [IntPtr]::Zero) {
      Log-Line ([ordered]@{ dir = 'out'; ok = $false; code = 'SESSION_LOCKED'; chars = 0 })
      Write-Output 'SESSION_LOCKED: this workstation has no foreground window, so keystrokes go nowhere. Reads and screenshots still work. Unlock and retry.'
      exit 10
    }
    $text = ''
    if ($TextFile -and (Test-Path $TextFile)) { $text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8) }
    elseif ([Console]::In.Peek() -ge 0) { $text = [Console]::In.ReadToEnd() }
    $text = ($text -replace "`r", '' ).Trim()
    if (-not $text) { Write-Output 'EMPTY_INPUT'; exit 2 }
    # The handshake you taught him: every bridge reply opens with this, so nobody has to wonder who is typing.
    if (-not $NoPrefix -and $text -notmatch '^\[Qwenny via Pi\]') { $text = "[Qwenny via Pi]`n" + $text }
    if ($text.Length -gt 4000) { Write-Output "TOO_LONG: $($text.Length) chars, cap is 4000 - send a file path or a summary instead"; exit 2 }

    $hits = Find-Secrets $text
    if ($hits.Count -and -not $Force) {
      Log-Line ([ordered]@{ dir = 'blocked'; hits = $hits; chars = $text.Length; head = $text.Substring(0, [Math]::Min(60, $text.Length)) })
      Write-Output "REDACTED: refusing to send, matched: $($hits -join ', '). Nothing was typed."
      exit 5
    }
    $s = Get-State
    $recent = @($s.sent | Where-Object { (Get-Date) - [DateTime]$_.ToString() -lt [TimeSpan]::FromHours(1) })
    $cap = if ($env:DB_MAX_PER_HOUR) { [int]$env:DB_MAX_PER_HOUR } else { 6 }
    if ($recent.Count -ge $cap) { Write-Output "RATE_CAP: $cap messages/hour reached ($($recent.Count)). Wait, or raise DB_MAX_PER_HOUR deliberately."; exit 6 }

    if (-not $target.edit) { Write-Output "NO_COMPOSER: $($target.note)"; exit 3 }
    # The visible tab is the only honest answer to "where will these keystrokes land". Find-Target proves the
    # target exists by finding a document matching /Stunkus/, and with the Muse tab in the background that
    # document still gets handed back - invisible, focusable-looking, and unable to receive what we type, so the
    # keystrokes and the Enter that submits land on whatever tab the user is looking at. The first time that
    # happened the front tab was GitHub's "Personal Access Tokens (Classic)" page. The window title tracks the
    # selected tab, so the title is the check, and it runs before the clipboard is touched.
    $visTitle = ''
    try { $visTitle = [string]$target.window.Current.Name } catch { }
    if (-not $visTitle) {
      # UIA's window Name came back empty in the field, which would have made this check a permanent lockout.
      # Win32 window text is the ground truth for a top-level window title, so ask the window itself.
      $sb = New-Object System.Text.StringBuilder 512
      [void][Native.Win32]::GetWindowText($target.hwnd, $sb, 512)
      $visTitle = $sb.ToString()
    }
    if ($visTitle -and $visTitle -notmatch 'Stunkus') {
      Log-Line ([ordered]@{ dir = 'blocked'; code = 'WRONG_TAB'; title = $visTitle; chars = $text.Length })
      Write-Output "WRONG_TAB: the visible Firefox tab is '$visTitle', not the Stunkus chat. Nothing was typed."
      Write-Output '         Reads still work against a background tab. Click the Muse tab, then retry.'
      exit 11
    }
    if (-not $visTitle) {
      Log-Line ([ordered]@{ dir = 'blocked'; code = 'TITLE_UNKNOWN'; chars = $text.Length })
      Write-Output 'TITLE_UNKNOWN: no window title from UIA or Win32, so there is no evidence which tab is in front. Nothing was typed.'
      Write-Output '         Bring the Stunkus tab to the front of that window and retry (pass --ForceTitle if you have verified it by eye).'
      exit 12
    }
    Set-Foreground $target.hwnd
    # SetFocus is an instance method on the element. The [FocusPattern] *type literal* does not resolve in
    # Windows PowerShell and aborted the first real send before a single key was pressed.
    try { $target.edit.SetFocus(); Start-Sleep -Milliseconds 150 } catch { }

    # two ways in: UIA SetValue first (no focus stealing, no keystrokes), clipboard paste if the DOM disagrees
    [void](Set-EditValue $target.edit '')
    [void](Paste-IntoEdit $text)
    $landed = Read-EditValue $target.edit
    if ("$landed".Trim() -ne $text) {
      if (Set-EditValue $target.edit $text) { $landed = Read-EditValue $target.edit }
    }
    if ("$landed".Trim() -ne $text) {
      Log-Line ([ordered]@{ dir = 'out'; ok = $false; code = 'SEND_UNVERIFIED'; chars = $text.Length })
      Write-Output "SEND_UNVERIFIED: composer holds $(("$landed").Length) of $($text.Length) chars. Nothing was submitted."
      exit 7
    }
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $s.sent = @(@($s.sent) + (Get-Date).ToString('o')); $s.sent = @($s.sent | Select-Object -Last 40)
    if ($InReplyTo) {
      # Only real message hashes belong in the ledger. An empty or malformed key would silently become a
      # wildcard entry, and this file is what stops a turn being answered twice.
      if ($InReplyTo -cmatch '^[0-9A-F]{12}$') {
        $s.replied = @((@($s.replied) + $InReplyTo | Select-Object -Unique | Where-Object { $_ -cmatch '^[0-9A-F]{12}$' }) | Select-Object -Last 200)
      } else {
        Log-Line ([ordered]@{ dir = 'out'; warn = 'in_reply_to is not a 12-hex message hash, not ledgered'; value = $InReplyTo })
      }
    }
    Set-State $s
    Log-Line ([ordered]@{ dir = 'out'; ok = $true; chars = $text.Length; reply_to = $InReplyTo; hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').Substring(0, 12) })

    # confirm it appeared in the transcript, not merely left the textarea
    $seen = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 400
      $last = (Read-Transcript $target 4) | Where-Object { $_.role -eq 'me' } | Select-Object -Last 1
      if ($last -and $last.text.Length -ge 4) {
        $a = Strip-Tag $text; $b = $last.text
        if ($a.StartsWith($b.Substring(0, [Math]::Min(24, $b.Length)))) { $seen = $true; break }
      }
    }
    if (-not $seen) { Write-Output 'SENT_BUT_UNCONFIRMED: pressed Enter; the transcript did not show it. Look before resending.'; break }

    if (-not $ExpectReply) { Write-Output 'SENT'; break }
    $before = (Read-Transcript $target 1)
    $lastHash = ''
    if ($before -and $before[-1].role -ne 'me') { $lastHash = $before[-1].hash }
    elseif ($before) { $lastHash = $before[-1].hash }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      $t2 = Find-Target
      if (-not $t2.ok) { Start-Sleep -Seconds 5; continue }
      $m = Read-Transcript $t2 2
      if (-not $m) { continue }
      $last = $m[-1]
      if ($last.role -ne 'me' -and $last.hash -ne $lastHash -and $last.chars -gt 1) {
        $s2 = Get-State; $s2.last_hash = $last.hash; Set-State $s2
        Log-Line ([ordered]@{ dir = 'in'; hash = $last.hash; chars = $last.chars })
        Write-Output "REPLY ($($last.chars) chars, hash $($last.hash)):"
        Write-Output $last.text
        break
      }
    }
    Write-Output 'NO_REPLY_WITHIN_TIMEOUT'
    break
  }

  'shot' {
    $hwnd = [IntPtr]$target.hwnd
    $rect = $AE::RootElement.FindFirst($SC, (Cond $AE::ProcessIdProperty $target.pid)).Current.BoundingRectangle
    if ([Math]::Abs([int]$rect.Width) -lt 20 -or [Math]::Abs([int]$rect.Height) -lt 20) { Write-Output 'WINDOW_IS_MINIMISED'; exit 8 }
    $locked = ([Native.Win32]::GetForegroundWindow() -eq [IntPtr]::Zero)
    # Screen scraping returns a black frame the moment this workstation locks (measured: mean luma 0.0
    # locked vs 40.3 via PrintWindow). PrintWindow with PW_RENDERFULLCONTENT renders the real page through
    # the lock, so it is the primary path and the desktop DC is only a fallback.
    $bmp = New-Object Drawing.Bitmap ([int]$rect.Width), ([int]$rect.Height)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $okp = [Native.Win32]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc)
    $method = "PrintWindow($okp)"
    $lum = Get-Luma $bmp
    if ($lum -lt 2.0) {
      $sz = New-Object Drawing.Size ([int]$rect.Width), ([int]$rect.Height)
      $g2 = [Drawing.Graphics]::FromImage($bmp)
      $g2.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $sz)
      $g2.Dispose()
      $method = 'CopyFromScreen(fallback)'
      $lum = Get-Luma $bmp
    }
    $g.Dispose()
    if ($lum -lt 2.0) {
      $bmp.Dispose()
      Write-Output 'BLANK_CAPTURE: both paths returned black. The desktop has no renderable surface right now.'
      if ($locked) { Write-Output 'SESSION_LOCKED is expected to allow reads via UIA; screenshots may need a wake.' }
      exit 9
    }
    $out = Join-Path $Shots ("stunkus-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $bmp.Save($out, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Log-Line ([ordered]@{ dir = 'shot'; file = $out; rect = $target.rect; method = $method; luma = [Math]::Round($lum, 1); locked = $locked })
    Write-Output "$out  ($method luma $([Math]::Round($lum,1)) locked=$locked)"
    break
  }

  # One reply per message, ever. afk.ps1 keeps its own ledger; this is the copy a human can read and repair.
  'mark'   {
    if (-not $Arg1) { Write-Output 'usage: mark <message-hash>'; exit 2 }
    # Same shape rule as the send path: a key that can never match a real hash is not a safety record, it is
    # noise that makes the ledger look populated when it is not.
    if (-not ($Arg1 -cmatch '^[0-9A-F]{12}$')) { Write-Output "refusing: '$Arg1' is not a 12-hex message hash (peek prints the hash for each turn)"; exit 2 }
    $s = Get-State
    if (@($s.replied) -contains $Arg1) { Write-Output "already marked: $Arg1"; break }
    $s.replied = @((@($s.replied) + $Arg1 | Where-Object { $_ }) | Select-Object -Last 200)
    Set-State $s
    Log-Line ([ordered]@{ dir = 'ledger'; action = 'mark'; hash = $Arg1 })
    Write-Output "marked $Arg1"
    break
  }

  'pause'  { Set-Content -Path $PausePath -Value (Get-Date).ToString('o') -Encoding UTF8; Write-Output 'PAUSED'; break }
  'resume' { if (Test-Path $PausePath) { Remove-Item $PausePath -Force }; Write-Output 'RUNNING'; break }
  default { Write-Output "unknown verb: $Verb"; exit 1 }
}
