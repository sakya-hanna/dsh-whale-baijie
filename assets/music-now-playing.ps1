param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$ParentPid = 0
)

# 音乐伴舞探针：每 ~0.3 秒把「当前在播什么」原子写入 $OutFile（一行 JSON）。
# 两条来源：
#   1) Windows 系统媒体会话（SMTC）——QQ 音乐、浏览器等上报会话的播放器走这条；
#   2) 窗口标题兜底——网易云等**不上报 SMTC** 的播放器，从主窗口标题读「歌名 - 歌手」。
#      进度用本地计时估算（标题不变就累加），切歌即归零。
# 由 lib/music.mjs 作为常驻子进程启动（stdio 全忽略，输出只走文件，不经管道）。
# 为什么是 PowerShell 5.1：pwsh 7 没有 WinRT 投影；5.1 自带，但异步要 AsTask 包装。
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}

# 默认输出设备的瞬时峰值（CoreAudio）。用来判断「到底有没有声音」：
# 窗口标题只告诉我们「哪首歌」，不知道暂停/播完；没有这一层，暂停时进度会继续跑，
# 恢复后整首歌词就会超前（用户实测：暂停后歌词还在推进、恢复后偏快）。
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshPeak {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  private class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IAudioMeterInformation {
    int GetPeakValue(out float peak);
  }

  public static float GetPeak() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev;
    int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out dev);
    if (hr != 0 || dev == null) throw new Exception("GetDefaultAudioEndpoint hr=" + hr);
    var iid = typeof(IAudioMeterInformation).GUID;
    object obj;
    hr = dev.Activate(ref iid, 23, IntPtr.Zero, out obj);
    if (hr != 0 || obj == null) throw new Exception("Activate hr=" + hr);
    var meter = (IAudioMeterInformation)obj;
    float peak;
    hr = meter.GetPeakValue(out peak);
    if (hr != 0) throw new Exception("GetPeakValue hr=" + hr);
    return peak;
  }
}
'@
} catch {}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, [Type]$type) {
  $asTask = $asTaskGeneric.MakeGenericMethod($type)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 窗口标题兜底：按进程枚举所有顶层窗口（含托盘隐藏的），取第一个带「 - 」的标题。
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshWinTitle {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static string Find(uint target) {
    string found = null;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (!string.IsNullOrWhiteSpace(t) && t.Contains(" - ")) { found = t; return false; }
      return true;
    }, IntPtr.Zero);
    return found ?? "";
  }
}
'@
} catch {}

# 已知播放器进程名（窗口标题兜底只认这些，避免误读浏览器/编辑器标题）
$playerNames = @('cloudmusic', 'QQMusic', 'KuGou', 'SodaMusic', 'Spotify', 'foobar2000')

function Get-WindowTrack {
  foreach ($name in $playerNames) {
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
      $title = ''
      try { $title = [DshWinTitle]::Find([uint32]$p.Id) } catch {}
      if (-not $title) { try { $title = [string]$p.MainWindowTitle } catch {} }
      if (-not $title -or $title -notmatch ' - ') { continue }
      $idx = $title.LastIndexOf(' - ')
      $track = $title.Substring(0, $idx).Trim()
      $artist = $title.Substring($idx + 3).Trim()
      if (-not $track) { continue }
      return [ordered]@{ title = $track; artist = $artist; app = $name }
    }
  }
  return $null
}

$lastKey = ''
$estPos = 0.0
$silentSince = 0.0
$armed = $false
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$prevTick = 0.0

# [PlaybackStatus] 4 = Playing
while ($true) {
  if ($ParentPid -gt 0) {
    try {
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    } catch { break }
  }

  $now = $sw.Elapsed.TotalSeconds
  $elapsed = [Math]::Max(0.0, $now - $prevTick)
  $prevTick = $now

  # 有声音才推进估算进度；静音超过 2.5 秒算暂停（窗口标题不知道暂停/播完）
  $peak = 1.0
  try { $peak = [DshPeak]::GetPeak() } catch {}
  $silent = ($peak -lt 0.02)

  $obj = $null
  try {
    $mgr = Await ($mgrType::RequestAsync()) $mgrType
    $sessions = @($mgr.GetSessions())
    $pick = $null
    foreach ($s in $sessions) {
      try {
        if ([int]$s.GetPlaybackInfo().PlaybackStatus -eq 4) { $pick = $s; break }
      } catch {}
    }
    if (-not $pick) {
      try { $pick = $mgr.GetCurrentSession() } catch {}
    }
    if ($pick) {
      $info = $pick.GetPlaybackInfo()
      $props = Await ($pick.TryGetMediaPropertiesAsync()) $propsType
      $tl = $pick.GetTimelineProperties()
      $pos = [double]$tl.Position.TotalSeconds
      $end = [double]$tl.EndTime.TotalSeconds
      # 外推：SMTC 的 Position 是「最近一次上报」的采样值（InfLink 每秒一次），
      # 直接拿来用会永远落后最多 1 秒、歌词一顿一顿。按 LastUpdatedTime 补到「现在」。
      if ([int]$info.PlaybackStatus -eq 4) {
        try {
          $lu = $tl.LastUpdatedTime
          if ($lu -and $lu.Year -gt 2000) {
            $delta = ([DateTimeOffset]::UtcNow - $lu).TotalSeconds
            if ($delta -gt 0 -and $delta -lt 5) { $pos += $delta }
          }
        } catch {}
      }
      if ($end -gt 0 -and $pos -gt $end) { $pos = $end }
      if ($pos -lt 0) { $pos = 0 }
      $obj = [ordered]@{
        playing  = ([int]$info.PlaybackStatus -eq 4)
        title    = [string]$props.Title
        artist   = [string]$props.Artist
        app      = [string]$pick.SourceAppUserModelId
        position = [double]$pos
        duration = [double]$end
        source   = 'smtc'
      }
    }
  } catch {}

  # SMTC 没有在播会话（或整个不可用）→ 试窗口标题兜底
  if ($null -eq $obj -or -not $obj.playing) {
    $win = $null
    try { $win = Get-WindowTrack } catch {}
    if ($win) {
      $key = ([string]$win.title) + '|' + ([string]$win.artist)
      if ($key -ne $lastKey) {
        $estPos = 0.0
        $lastKey = $key
        $silentSince = 0.0
        $armed = $false   # 切歌后先等「真的有声音」再起算，抵掉缓冲/前奏延迟
      }
      if ($silent) {
        if ($silentSince -le 0) { $silentSince = $now }
        # 短暂静音（气口/间奏）不算暂停；超过 2.5 秒才当成真的暂停/播完
        $winPlaying = (($now - $silentSince) -lt 2.5)
      } else {
        $silentSince = 0.0
        $winPlaying = $true
        if (-not $armed) {
          $estPos = 0.0
          $armed = $true
        } else {
          $estPos += $elapsed
        }
      }
      $obj = [ordered]@{
        playing  = $winPlaying
        title    = [string]$win.title
        artist   = [string]$win.artist
        app      = [string]$win.app
        position = [double]$estPos
        duration = 0.0
        source   = 'window'
      }
    }
  }

  if ($null -eq $obj) { $obj = [ordered]@{ playing = $false }; $lastKey = ''; $estPos = 0.0; $armed = $false }
  try {
    $json = $obj | ConvertTo-Json -Compress
    $tmp = $OutFile + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $utf8)
    Move-Item -LiteralPath $tmp -Destination $OutFile -Force
  } catch {}
  Start-Sleep -Milliseconds 300
}


