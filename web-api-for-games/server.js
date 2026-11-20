// Echo Show as a second Windows monitor, started by "Alexa, open second screen".
// No npm dependencies. Needs Node >= 18, ffmpeg >= 6 and cloudflared.
//
//   node server.js        (or start.cmd) is all you need:
//     - turns the virtual monitor on if it's off (UAC prompt), leaves it on when you quit
//     - finds the virtual monitor automatically (first start only, saved in monitor.json)
//     - starts a Cloudflare quick tunnel (http2), writes its URL into the skill package and runs
//       "ask deploy --ignore-hash"
//     - touch on: tap/drag/long-press on the Echo controls the Windows mouse, two fingers = scroll,
//       keyboard button = Windows on-screen keyboard on the virtual monitor
//     - only sends frames when the screen changes (idle desktop = almost no traffic)
//
// Options (all optional):
//   --no-touch            picture only, no input from the Echo
//   --no-vdd              don't turn the virtual monitor on at start if it's off
//   --no-tunnel           LAN only, for the Silk browser (no skill)
//   --no-deploy           don't run "ask deploy" after the tunnel starts
//   --redetect            search the virtual monitor again (e.g. after changing its resolution)
//   --probe               list every GPU/monitor combination and exit
//   --adapter N --display N --target WxH   pick the monitor by hand
//   --input-monitor N     which Windows monitor touch controls (number from the monitor list)
//   --public-url URL      fixed HTTPS URL instead of a quick tunnel (e.g. a named Cloudflare tunnel)
//   --key SECRET          fixed access key instead of a random one per start
//   --tunnel-protocol P   http2 (default), quic or auto
//   --skill-mode poll     skill page polls single frames instead of MJPEG (if the stream stalls)
//   --source test         test pattern instead of the screen
//   --verbose             show the ffmpeg command line
//   --all-frames          send every frame (default: only frames where the screen changed)
//   --port 8080 --fps 10 --quality 6

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
// Without this, PowerShell prints its progress bar ("Preparing modules for first use") as CLIXML.
const PS_QUIET = "$ProgressPreference = 'SilentlyContinue'; ";
const crypto = require('crypto');

// ---------- Options ----------
const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const PORT = parseInt(opt('port', '8080'), 10);
const FPS = parseInt(opt('fps', '10'), 10);
const QUALITY = parseInt(opt('quality', '6'), 10); // ffmpeg -q:v, 2 = best, 31 = worst
const SCALE = opt('scale', '1280');                // target width in px, "0" = no scaling
const SOURCE = opt('source', 'ddagrab');           // ddagrab | gdigrab | test
let DISPLAY = opt('display', '');                  // empty = auto-detect the virtual monitor
// Without --ffmpeg: on Windows prefer the Gyan ffmpeg installed via winget (recent, has ddagrab),
// because an old ffmpeg may come first in PATH.
function findFfmpeg() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return 'ffmpeg';
  const base = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  try {
    const pkg = fs.readdirSync(base).find((d) => d.startsWith('Gyan.FFmpeg'));
    if (!pkg) return 'ffmpeg';
    const build = fs.readdirSync(path.join(base, pkg)).filter((d) => d.startsWith('ffmpeg-')).sort().pop();
    const exe = build && path.join(base, pkg, build, 'bin', 'ffmpeg.exe');
    return exe && fs.existsSync(exe) ? exe : 'ffmpeg';
  } catch (e) { return 'ffmpeg'; }
}
const FFMPEG = opt('ffmpeg', '') || findFfmpeg();
let TARGET = opt('target', '');                    // e.g. 1280x800; empty = resolution of the detected monitor
const MONITOR = opt('monitor', '');
// Tunnel is on by default (needed for the Alexa skill). --no-tunnel = LAN only (Silk browser).
const TUNNEL = !args.includes('--no-tunnel');
let PUBLIC_URL = opt('public-url', '').replace(/\/$/, '');
const SKILL_MODE = opt('skill-mode', 'mjpeg');
// Access key for requests from the internet (through the tunnel). Not needed on the LAN.
// Fix it with --key, otherwise a new one on every start.
const KEY = opt('key', '') || crypto.randomBytes(9).toString('base64url');
let ADAPTER = opt('adapter', '');                  // DXGI adapter (GPU) for ddagrab; empty = auto-detect

// Read monitors via PowerShell. DPI-aware so the values are real pixels
// (otherwise Windows reports scaled-down values at 125/150 % -> only a crop gets captured).
function listMonitors() {
  if (process.platform !== 'win32') return [];
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiFix{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);}';` +
    `if (-not [DpiFix]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [DpiFix]::SetProcessDPIAware() | Out-Null }; Add-Type -AssemblyName System.Windows.Forms;` +
    `[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0};{1};{2};{3};{4};{5}' -f $_.DeviceName,$_.Primary,$_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height }`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(PS_QUIET + ps, 'utf16le').toString('base64')], { encoding: 'utf8' });
    return out.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const [name, primary, x, y, w, h] = line.trim().split(';');
      return { nr: i + 1, name, primary: primary === 'True', x: +x, y: +y, w: +w, h: +h };
    });
  } catch (e) {
    console.error('[monitors] could not be read:', e.message);
    return [];
  }
}

// ---------- Make sure the virtual monitor is on ----------
// If the virtual display driver is disabled (e.g. with driver\vdd.cmd off), turn it on at start.
// Enabling a device needs admin rights, so Windows shows a UAC prompt. Nothing happens on exit:
// the monitor stays on. --no-vdd skips the check.
const VDD_MATCH = "FriendlyName -match 'Virtual Display|IddSample|MttVDD'";
function psRun(ps) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(PS_QUIET + ps, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ensureVirtualMonitor() {
  if (process.platform !== 'win32' || SOURCE === 'test' || args.includes('--no-vdd')) return;
  const statusPs = `@(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.${VDD_MATCH} } | ForEach-Object { $_.Status }) -join ','`;
  let status;
  try { status = psRun(statusPs); } catch (e) { console.error('[vdd] could not check the virtual display driver:', e.message); return; }
  if (!status) { console.log('[vdd] no virtual display driver found (see README, "Installing the virtual display driver")'); return; }
  if (status.split(',').includes('OK')) { console.log('[vdd] virtual monitor is on'); return; }
  console.log('[vdd] virtual monitor is off, turning it on. Please confirm the Windows admin prompt ...');
  const enablePs = `Get-PnpDevice -Class Display | Where-Object { $_.${VDD_MATCH} -and $_.Status -eq 'Error' } | Enable-PnpDevice -Confirm:$false`;
  const elevatePs = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(PS_QUIET + enablePs, 'utf16le').toString('base64')}'`;
  try { psRun(elevatePs); } catch (e) { console.error('[vdd] not turned on (admin prompt declined?). Run driver\\vdd.cmd on'); return; }
  // Windows needs a moment until the new monitor shows up for ddagrab
  for (let i = 0; i < 10; i++) {
    sleepMs(1000);
    try { if (psRun(statusPs).split(',').includes('OK')) { sleepMs(2000); console.log('[vdd] virtual monitor is on'); return; } } catch (e) { /* retry */ }
  }
  console.error('[vdd] the virtual monitor did not come on. Check Device Manager or run driver\\vdd.cmd on');
}
ensureVirtualMonitor();

// ---------- Find the virtual monitor ----------
// ddagrab only sees the monitors of ONE GPU (DXGI adapter). We try every adapter/output combination
// and pick the one with an Echo Show resolution. The result is saved in CONFIG_FILE, so this runs only once.
const CONFIG_FILE = path.join(__dirname, 'monitor.json');
const ECHO_RESOLUTIONS = ['1280x800', '1340x800', '960x480', '1024x600', '1920x1200', '1920x1080'];

function probeOne(a, d) {
  const { spawnSync } = require('child_process');
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'verbose',
    '-init_hw_device', `d3d11va=dda:${a}`, '-filter_hw_device', 'dda',
    '-filter_complex', `ddagrab=output_idx=${d}:framerate=5,hwdownload,format=bgra`,
    '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000 });
  const log = (r.stderr || '') + (r.stdout || '');
  const m = log.match(/Opened dxgi output \d+ with dimensions (\d+)x(\d+)/);
  return m ? { adapter: String(a), display: String(d), res: `${m[1]}x${m[2]}` } : null;
}
function probeOutputs() {
  const found = [];
  for (let a = 0; a < 4; a++) for (let d = 0; d < 4; d++) { const o = probeOne(a, d); if (o) found.push(o); }
  return found;
}

function pickOutput(found) {
  // With --target, take exactly that resolution. Otherwise the first Echo resolution in ECHO_RESOLUTIONS order.
  const wanted = TARGET ? [TARGET.toLowerCase()] : ECHO_RESOLUTIONS;
  const hits = found.filter((o) => wanted.includes(o.res));
  if (hits.length > 1) {
    console.log('[monitor] several monitors with an Echo resolution:');
    for (const o of hits) console.log(`   adapter ${o.adapter}, display ${o.display}: ${o.res}`);
  }
  for (const res of wanted) {
    const hit = hits.find((o) => o.res === res);
    if (hit) return hit;
  }
  return null;
}

if (args.includes('--probe')) {
  console.log(`Testing ddagrab with ${FFMPEG} ...\n`);
  const found = probeOutputs();
  for (const o of found) console.log(`  --adapter ${o.adapter} --display ${o.display}  ->  ${o.res}`);
  const pick = pickOutput(found);
  console.log(pick ? `\nAuto-detect would pick: --adapter ${pick.adapter} --display ${pick.display} (${pick.res})`
    : '\nNo monitor with an Echo Show resolution found. Set the virtual monitor to the Echo\'s resolution first.');
  process.exit(0);
}

if (SOURCE === 'ddagrab' && (!ADAPTER || !DISPLAY)) {
  let saved = null;
  if (!args.includes('--redetect')) {
    try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* first start */ }
  }
  // The saved numbers can point to another monitor after monitors were added, removed or the
  // virtual one was switched off and on (Windows renumbers the outputs). So check it on every start:
  // the saved output must still have the saved resolution. A laptop-sized pick (1920x...) is
  // searched again every time, because it may be the laptop screen chosen while the virtual
  // monitor was off.
  if (saved) {
    const now = probeOne(saved.adapter, saved.display);
    if (!now || now.res !== saved.res || saved.res.startsWith('1920x')) {
      if (!saved.res.startsWith('1920x')) console.log(`[monitor] saved monitor (adapter ${saved.adapter}, display ${saved.display}, ${saved.res}) is now ${now ? now.res : 'gone'}, searching again`);
      saved = null;
    }
  }
  if (saved && (!TARGET || saved.res === TARGET.toLowerCase())) {
    console.log(`[monitor] using saved monitor: adapter ${saved.adapter}, display ${saved.display}, ${saved.res}  (search again: --redetect)`);
  } else {
    console.log('[monitor] looking for the virtual monitor (takes a few seconds) ...');
    const found = probeOutputs();
    saved = pickOutput(found);
    if (!saved) {
      console.error('[monitor] No monitor with an Echo Show resolution (' + ECHO_RESOLUTIONS.join(', ') + ') found.');
      for (const o of found) console.error(`   adapter ${o.adapter}, display ${o.display}: ${o.res}`);
      console.error('[monitor] Set the virtual monitor to your Echo\'s resolution, or pass --adapter N --display N --target WxH.');
      process.exit(1);
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
    console.log(`[monitor] found: adapter ${saved.adapter}, display ${saved.display}, ${saved.res}  (saved in monitor.json)`);
  }
  ADAPTER = ADAPTER || saved.adapter;
  DISPLAY = DISPLAY || saved.display;
  TARGET = TARGET || saved.res;
}
if (!ADAPTER) ADAPTER = '0';
if (!DISPLAY) DISPLAY = '1';

// ---------- Touch -> Windows mouse ----------
// Touch is on by default. --no-touch = picture only (nobody can click on your PC through the Echo).
const TOUCH = !args.includes('--no-touch');
let inputMon = null;   // {x,y,w,h} of the controlled monitor in real pixels
let inputProc = null;
let httpInputLogged = false;

function startInputHelper() {
  if (process.platform !== 'win32') { console.log('[touch] Windows only'); return; }
  const mons = listMonitors();
  console.log('\n[touch] Monitors:');
  for (const m of mons) console.log(`   ${m.nr}: ${m.name}  ${m.w}x${m.h} at ${m.x},${m.y}${m.primary ? '  (main display)' : ''}`);
  const [tw, th] = TARGET ? TARGET.toLowerCase().split('x').map(Number) : [0, 0];
  inputMon = opt('input-monitor', '') ? mons.find((m) => m.nr === parseInt(opt('input-monitor', ''), 10))
    : mons.find((m) => m.w === tw && m.h === th) || mons.find((m) => !m.primary) || mons[0];
  if (!inputMon) { console.error('[touch] no monitor found'); return; }
  console.log(`[touch] controlling monitor ${inputMon.nr}: ${inputMon.name} ${inputMon.w}x${inputMon.h} at ${inputMon.x},${inputMon.y}  (other: --input-monitor N)`);
  const ps = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Inp {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
# Per-monitor DPI (V2) so coordinates are right even with different scaling per monitor
if (-not [Inp]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [Inp]::SetProcessDPIAware() | Out-Null }
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' ')
  if ($p[0] -eq 'K' -and $p.Length -ge 5) {
    # Toggle the Windows on-screen keyboard (osk.exe). It remembers its position in the
    # registry, so we write the virtual monitor's bottom area there before starting it.
    $o = Get-Process osk -ErrorAction SilentlyContinue
    if ($o) {
      try { $o | Stop-Process -Force -ErrorAction Stop } catch { Write-Host "[keyboard] could not close osk.exe: $_" }
      continue
    }
    $k = 'HKCU:\\Software\\Microsoft\\Osk'
    if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null }
    Set-ItemProperty $k WindowLeft ([int]$p[1]) -Type DWord
    Set-ItemProperty $k WindowTop ([int]$p[2]) -Type DWord
    Set-ItemProperty $k WindowWidth ([int]$p[3]) -Type DWord
    Set-ItemProperty $k WindowHeight ([int]$p[4]) -Type DWord
    try { Start-Process osk.exe -ErrorAction Stop } catch { Write-Host "[keyboard] could not start osk.exe: $_"; continue }
    # osk.exe doesn't always respect the registry position (e.g. on another monitor), so move
    # its window once it exists. 0x0040 = SWP_SHOWWINDOW, -1 = HWND_TOPMOST.
    # Find the window through the process (works whatever the window class is called), up to 10 s.
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) {
      Start-Sleep -Milliseconds 100
      $o = Get-Process osk -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($o -and $o.MainWindowHandle -ne [IntPtr]::Zero) { $h = $o.MainWindowHandle }
      else { $h = [Inp]::FindWindow('OSKMainClass', $null) }
    }
    if ($h -eq [IntPtr]::Zero) { Write-Host "[keyboard] osk window not found (osk process running: $([bool](Get-Process osk -ErrorAction SilentlyContinue)))"; continue }
    $cls = New-Object System.Text.StringBuilder 256; [Inp]::GetClassName($h, $cls, 256) | Out-Null
    Start-Sleep -Milliseconds 300
    $ok = [Inp]::SetWindowPos($h, [IntPtr]::new(-1), [int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], 0x0040)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $r = New-Object Inp+RECT; [Inp]::GetWindowRect($h, [ref]$r) | Out-Null
    Write-Host "\`n[keyboard] window $cls, wanted $($p[1]),$($p[2]) $($p[3])x$($p[4]), move ok=$ok err=$err, now at $($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"
    continue
  }
  if ($p.Length -lt 3) { continue }
  [Inp]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
  switch ($p[0]) {
    'D' { [Inp]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
    'U' { [Inp]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
    'R' { [Inp]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); [Inp]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero) }
    'W' { if ($p.Length -ge 4) { [Inp]::mouse_event(0x0800, 0, 0, [int]$p[3], [UIntPtr]::Zero) } }
  }
}`;
  inputProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(PS_QUIET + ps, 'utf16le').toString('base64')], { stdio: ['pipe', 'inherit', 'inherit'] });
  inputProc.on('exit', (c) => { console.error(`[touch] helper exited (code ${c})`); inputProc = null; });
  process.on('exit', () => { if (inputProc) inputProc.kill(); });
}

// Frame coordinate (0..1 in the served frame) -> Windows pixel on the controlled monitor.
// Accounts for the black bars of --target when the aspect ratio differs.
function frameToScreen(fx, fy) {
  const m = inputMon;
  let sx = fx, sy = fy;
  if (TARGET) {
    const [tw, th] = TARGET.toLowerCase().split('x').map(Number);
    const s = Math.min(tw / m.w, th / m.h);
    const ox = (tw - m.w * s) / 2, oy = (th - m.h * s) / 2;
    sx = (fx * tw - ox) / (m.w * s);
    sy = (fy * th - oy) / (m.h * s);
  }
  sx = Math.min(Math.max(sx, 0), 0.9999);
  sy = Math.min(Math.max(sy, 0), 0.9999);
  return [Math.floor(m.x + sx * m.w), Math.floor(m.y + sy * m.h)];
}

function handleInput(ev) {
  if (!inputProc || !inputMon) { if (!handleInput.warned) { handleInput.warned = true; console.error('[touch] gesture received, but the mouse helper is not running (see messages above)'); } return; }
  if (ev.t === 'key') {
    // On-screen keyboard across the bottom 40 % of the controlled monitor
    const m = inputMon, h = Math.round(m.h * 0.4);
    console.log('\n[keyboard] toggling the on-screen keyboard');
    inputProc.stdin.write(`K ${m.x} ${m.y + m.h - h} ${m.w} ${h}\n`);
    return;
  }
  const cmd = { down: 'D', move: 'M', up: 'U', right: 'R', wheel: 'W' }[ev.t];
  if (!cmd || typeof ev.x !== 'number' || typeof ev.y !== 'number') return;
  const [x, y] = frameToScreen(ev.x, ev.y);
  if (cmd === 'W') {
    const d = Math.max(-1200, Math.min(1200, Math.round(Number(ev.d) || 0)));
    if (d) inputProc.stdin.write(`W ${x} ${y} ${d}\n`);
    return;
  }
  inputProc.stdin.write(`${cmd} ${x} ${y}\n`);
}

let region = null; // {x,y,w,h} for gdigrab
if (SOURCE === 'gdigrab' && args.indexOf('--offset-x') < 0) {
  const mons = listMonitors();
  console.log('\nMonitors found:');
  for (const m of mons) console.log(`   ${m.nr}: ${m.name}  ${m.w}x${m.h} at ${m.x},${m.y}${m.primary ? '  (main display)' : ''}`);
  const pick = MONITOR ? mons.find((m) => m.nr === parseInt(MONITOR, 10))
                       : mons.find((m) => !m.primary) || mons[0];
  if (!pick) { console.error('No matching monitor. Use --monitor N or --offset-x/--width/--height.'); process.exit(1); }
  console.log(`-> using monitor ${pick.nr} (${pick.w}x${pick.h}). Pick another with --monitor N`);
  region = { x: pick.x, y: pick.y, w: pick.w, h: pick.h };
}

// Only changed frames: mpdecimate drops frames that look like the previous one, and
// -fps_mode vfr makes ffmpeg skip them instead of duplicating. An idle desktop then costs
// almost no bandwidth. --all-frames turns it off (constant frame rate, old behavior).
const ALL_FRAMES = args.includes('--all-frames');
const DECIMATE = ALL_FRAMES ? '' : ',mpdecimate';
const FPS_MODE = ALL_FRAMES ? [] : ['-fps_mode', 'vfr'];

function ffmpegArgs() {
  let scale = SCALE !== '0' ? `,scale=${SCALE}:-2` : '';
  if (TARGET) {
    const [tw, th] = TARGET.toLowerCase().split('x').map((n) => parseInt(n, 10));
    // keep aspect ratio, fit, pad the rest with black -> exactly tw x th
    scale = `,scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2`;
  }
  let input;
  let vf;
  if (SOURCE === 'ddagrab') {
    // Desktop Duplication API, captures exactly one monitor (virtual ones too).
    // ddagrab only sees the monitors of ONE GPU (DXGI adapter). On Intel+Nvidia laptops
    // and for virtual monitors the right one often sits on adapter 1 or 2 -> --adapter N.
    return ['-hide_banner', '-loglevel', 'warning',
      '-init_hw_device', `d3d11va=dda:${ADAPTER}`, '-filter_hw_device', 'dda',
      '-filter_complex', `ddagrab=output_idx=${DISPLAY}:framerate=${FPS}:draw_mouse=1,hwdownload,format=bgra${scale}${DECIMATE}`,
      ...FPS_MODE, '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', String(QUALITY), '-f', 'mjpeg', 'pipe:1'];
  } else if (SOURCE === 'gdigrab') {
    input = ['-f', 'gdigrab', '-framerate', String(FPS), '-draw_mouse', '1',
      '-offset_x', String(region ? region.x : opt('offset-x', '1920')),
      '-offset_y', String(region ? region.y : opt('offset-y', '0')),
      '-video_size', region ? `${region.w}x${region.h}` : `${opt('width', '1280')}x${opt('height', '800')}`,
      '-i', 'desktop'];
    vf = `null${scale}`;
  } else {
    input = ['-re', '-f', 'lavfi', '-i', `testsrc2=size=1280x800:rate=${FPS}`];
    vf = `null${scale}`;
  }
  return ['-hide_banner', '-loglevel', 'warning', ...input,
    '-vf', vf + DECIMATE, ...FPS_MODE, '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', String(QUALITY),
    '-f', 'mjpeg', 'pipe:1'];
}

// ---------- Capture: ffmpeg writes JPEGs back to back to stdout ----------
let latestFrame = null;
let frameCount = 0;
const clients = new Set();
let ff = null;

function startCapture() {
  const a = ffmpegArgs();
  if (args.includes('--verbose')) console.log('[ffmpeg]', FFMPEG, a.join(' '));
  ff = spawn(FFMPEG, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  // MJPEG needs the "yuvj" full-range pixel format. ffmpeg calls it deprecated but has no
  // working replacement for MJPEG yet (yuv420p gives washed-out colors), so hide that warning.
  ff.stderr.on('data', (d) => {
    const lines = d.toString().split(/\r?\n/).filter((l) => l.trim() && !/deprecated pixel format/.test(l));
    if (lines.length) process.stderr.write(lines.join('\n') + '\n');
  });
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    // A JPEG starts with FF D8 and ends with FF D9. Thanks to byte stuffing
    // FF D9 never appears inside the image data, so this search is enough.
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { buf = Buffer.alloc(0); break; }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { if (start > 0) buf = buf.subarray(start); break; }
      const frame = Buffer.from(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
      onFrame(frame);
    }
  });
  ff.on('error', (e) => {
    console.error(`[ffmpeg] could not be started (${e.message}). Is ffmpeg in PATH? Otherwise --ffmpeg C:\\path\\ffmpeg.exe`);
  });
  ff.on('exit', (code) => {
    console.error(`[ffmpeg] exited with code ${code}. Restarting in 2 s ...`);
    ff = null;
    setTimeout(startCapture, 2000);
  });
}

let lastSent = 0;
function onFrame(frame, repeat) {
  latestFrame = frame;
  if (!repeat) frameCount++;
  lastSent = Date.now();
  for (const res of clients) {
    // Slow clients skip frames instead of building up buffers (low latency).
    if (res.writableNeedDrain) continue;
    onFrameTo(res, frame);
  }
}
// With only changed frames, an idle screen sends nothing. Resend the last frame every
// few seconds so proxies and tunnels don't close the idle connection.
setInterval(() => { if (latestFrame && clients.size && Date.now() - lastSent > 4000) onFrame(latestFrame, true); }, 1000);

// ---------- HTTP ----------
const viewerHtml = fs.readFileSync(path.join(__dirname, 'viewer.html'));

// ---------- Alexa skill ----------
const SKILL_JSON = path.join(__dirname, 'skill-package', 'skill.json');

function alexaResponse(response, sessionAttributes) {
  return { version: '1.0', sessionAttributes: sessionAttributes || {}, response };
}
function speech(text) { return { type: 'PlainText', text }; }

// Spoken replies per skill language (de-DE vs. en-US / en-GB)
const SPEECH = {
  en: {
    on: 'Second screen is on.',
    help: 'I show your second Windows screen. Say stop to end it.',
    off: 'Second screen off.',
    noScreen: 'This needs an Echo device with a screen.',
    error: 'Something went wrong.',
  },
  de: {
    on: 'Zweiter Bildschirm ist an.',
    help: 'Ich zeige deinen zweiten Windows Bildschirm. Sag stopp zum Beenden.',
    off: 'Zweiter Bildschirm aus.',
    noScreen: 'Dafür brauche ich ein Echo Gerät mit Bildschirm.',
    error: 'Da ist etwas schiefgegangen.',
  },
  fr: {
    on: 'Le deuxième écran est allumé.',
    help: "J'affiche ton deuxième écran Windows. Dis stop pour arrêter.",
    off: 'Deuxième écran éteint.',
    noScreen: "Il faut un appareil Echo avec écran.",
    error: "Une erreur s'est produite.",
  },
  es: {
    on: 'La segunda pantalla está encendida.',
    help: 'Muestro tu segunda pantalla de Windows. Di para para terminar.',
    off: 'Segunda pantalla apagada.',
    noScreen: 'Para esto necesito un dispositivo Echo con pantalla.',
    error: 'Algo salió mal.',
  },
  it: {
    on: 'Il secondo schermo è acceso.',
    help: 'Mostro il tuo secondo schermo Windows. Di stop per terminare.',
    off: 'Secondo schermo spento.',
    noScreen: 'Serve un dispositivo Echo con schermo.',
    error: 'Qualcosa è andato storto.',
  },
  pt: {
    on: 'A segunda tela está ligada.',
    help: 'Eu mostro sua segunda tela do Windows. Diga pare para encerrar.',
    off: 'Segunda tela desligada.',
    noScreen: 'Para isso preciso de um dispositivo Echo com tela.',
    error: 'Algo deu errado.',
  },
  nl: {
    on: 'Het tweede scherm staat aan.',
    help: 'Ik toon je tweede Windows-scherm. Zeg stop om te eindigen.',
    off: 'Tweede scherm uit.',
    noScreen: 'Hiervoor heb ik een Echo-apparaat met scherm nodig.',
    error: 'Er ging iets mis.',
  },
};
// Spoken replies follow the Echo's language (request.locale); everything else stays English.
function say(locale, key) {
  const lang = String(locale || '').slice(0, 2);
  return speech((SPEECH[lang] || SPEECH.en)[key]);
}

function startDirective(host) {
  const base = PUBLIC_URL || `https://${host}`;
  const q = `alexa=1&k=${encodeURIComponent(KEY)}${SKILL_MODE === 'poll' ? '&mode=poll' : ''}`;
  return {
    type: 'Alexa.Presentation.HTML.Start',
    data: {},
    request: { uri: `${base}/?${q}`, method: 'GET' },
    // Max 30 min without interaction; devices may allow less (per Amazon docs).
    configuration: { timeoutInSeconds: 1800 },
  };
}

function handleAlexa(body, host) {
  const r = body.request || {};
  const t = new Date().toLocaleTimeString();
  const intent = r.intent ? r.intent.name : '';
  console.log(`\n[${t}] Alexa: ${r.type}${intent ? ' / ' + intent : ''}${r.reason ? ' (' + r.reason + ')' : ''}${r.error ? ' ' + JSON.stringify(r.error) : ''}`);

  const ifaces = (((body.context || {}).System || {}).device || {}).supportedInterfaces || {};
  const hasHtml = !!ifaces['Alexa.Presentation.HTML'];

  if (r.type === 'SessionEndedRequest') return alexaResponse({}); // no response allowed, just log

  if (r.type === 'Alexa.Presentation.HTML.Message') {
    // Keep-alive from the page. Reply without speech and without shouldEndSession -> web app stays open.
    return alexaResponse({ directives: [{ type: 'Alexa.Presentation.HTML.HandleMessage', message: { type: 'pong', at: Date.now() } }] });
  }

  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent' || intent === 'AMAZON.NavigateHomeIntent') {
    return alexaResponse({ outputSpeech: say(r.locale, 'off'), shouldEndSession: true });
  }

  if (!hasHtml) {
    return alexaResponse({ outputSpeech: say(r.locale, 'noScreen'), shouldEndSession: true });
  }

  // LaunchRequest, ShowScreenIntent, HelpIntent, Fallback: (re)start the screen
  const text = say(r.locale, intent === 'AMAZON.HelpIntent' ? 'help' : 'on');
  // Don't set shouldEndSession: speech is spoken, mic stays closed, web app stays open.
  return alexaResponse({ outputSpeech: text, directives: [startDirective(host)] });
}

function isRemote(req) {
  // Requests through cloudflared carry these headers, LAN requests don't.
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
}

function updateSkillEndpoint(publicUrl) {
  try {
    const j = JSON.parse(fs.readFileSync(SKILL_JSON, 'utf8'));
    j.manifest.apis.custom.endpoint = { uri: `${publicUrl}/alexa`, sslCertificateType: 'Wildcard' };
    fs.writeFileSync(SKILL_JSON, JSON.stringify(j, null, 2));
    console.log(`[skill] Endpoint written to skill-package/skill.json: ${publicUrl}/alexa`);
  } catch (e) { console.error('[skill] skill.json not updated:', e.message); }
}

// The quick tunnel URL changes on every start, so push the new endpoint to Amazon automatically.
// Turn off with --no-deploy.
let deploying = false; // the [status] line stays quiet while the deploy spinner runs
function autoDeploy() {
  console.log('\n[skill] Deploying the skill with the new tunnel URL (about 1 minute).');
  console.log('[skill] \x1b[33mDon\'t start the skill yet\x1b[0m: until the deploy is done, Alexa still calls the old URL');
  console.log('        and answers "There was a problem with the requested skill\'s response".\n');
  const t0 = Date.now();
  deploying = true;
  const spin = ['|', '/', '-', '\\'];
  let n = 0;
  const spinner = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r\x1b[K  ${spin[n++ % 4]} Deploying ... ${sec} s`);
  }, 250);
  // One command string (not an args array): shell:true with args triggers Node's DEP0190 warning.
  const dep = spawn('ask deploy --ignore-hash', { cwd: __dirname, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  dep.stdout.on('data', (d) => { out += d; });
  dep.stderr.on('data', (d) => { out += d; });
  dep.on('error', (e) => console.error(`[skill] ask CLI not found (${e.message}). Run "ask deploy --ignore-hash" yourself.`));
  dep.on('exit', (code) => {
    clearInterval(spinner);
    deploying = false;
    process.stdout.write('\r\x1b[K');
    const sec = Math.round((Date.now() - t0) / 1000);
    if (code === 0) {
      const g = '\x1b[32m', r = '\x1b[0m';
      const rows = ['', `READY  (deploy took ${sec} s)`, '', 'Say "Alexa, open second screen"', 'German Echo: "Alexa, öffne zweiten Bildschirm"', ''];
      const w = Math.max(...rows.map((t) => t.length)) + 4;
      console.log(`${g}  ┌${'─'.repeat(w)}┐${r}`);
      for (const t of rows) console.log(`${g}  │  ${t.padEnd(w - 2)}│${r}`);
      console.log(`${g}  └${'─'.repeat(w)}┘${r}\n`);
    }
    else {
      console.error(`\n[skill] Deploy FAILED (code ${code}). Last output:`);
      console.error(out.trim().split(/\r?\n/).slice(-15).join('\n'));
    }
  });
}

function startTunnel() {
  const bin = opt('cloudflared', 'cloudflared');
  console.log('[tunnel] starting cloudflared quick tunnel ...');
  // http2 by default: QUIC (UDP 7844) is blocked in many networks. --tunnel-protocol quic|auto to change.
  const cf = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', opt('tunnel-protocol', 'http2'), '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (/Registered tunnel connection|ERR|error|failed/i.test(line)) console.log('[cloudflared]', line.trim());
    }
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
    if (m && !PUBLIC_URL) {
      PUBLIC_URL = m[0];
      console.log(`\n[tunnel] Public URL: ${PUBLIC_URL}`);
      updateSkillEndpoint(PUBLIC_URL);
      console.log(`[tunnel] Test in a browser:  ${PUBLIC_URL}/?k=${KEY}`);
      if (args.includes('--no-deploy')) console.log('[tunnel] Now run in this folder:  ask deploy --ignore-hash   (the quick tunnel URL changes on every start)');
      else autoDeploy();
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('error', (e) => console.error(`[tunnel] cloudflared not found (${e.message}). Pass its path with --cloudflared.`));
  cf.on('exit', (c) => console.error(`[tunnel] cloudflared exited (code ${c})`));
  process.on('exit', () => cf.kill());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/alexa' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try {
        const body = JSON.parse(raw);
        const r = body.request || {};
        // Log every request: if a failed start shows no line here, Alexa never reached this PC
        // (deploy not finished yet, or an old tunnel URL).
        console.log(`\n[${new Date().toLocaleTimeString()}] [skill] ${r.type || '?'}${r.intent ? ' ' + r.intent.name : ''}${r.reason ? ' (' + r.reason + ')' : ''}${r.error ? ' error: ' + JSON.stringify(r.error) : ''}`);
        out = handleAlexa(body, req.headers['x-forwarded-host'] || req.headers.host);
      }
      catch (e) { console.error('[skill] error:', e.message); out = alexaResponse({ outputSpeech: say('en', 'error'), shouldEndSession: true }); }
      res.writeHead(200, { 'Content-Type': 'application/json;charset=UTF-8' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // From the internet only with the key (otherwise anyone with the tunnel URL could see your screen).
  if (isRemote(req) && url.pathname !== '/keepawake.mp4' && url.searchParams.get('k') !== KEY) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403: key missing');
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(viewerHtml);
  }
  if (url.pathname === '/stream.mjpg') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'close',
    });
    res.socket.setNoDelay(true);
    clients.add(res);
    const since = Date.now();
    console.log(`\n[${new Date().toLocaleTimeString()}] Stream client connected: ${req.socket.remoteAddress} (${clients.size} active)`);
    res.write('--frame\r\n');
    if (latestFrame) onFrameTo(res, latestFrame);
    req.on('close', () => {
      clients.delete(res);
      const min = ((Date.now() - since) / 60000).toFixed(1);
      console.log(`\n[${new Date().toLocaleTimeString()}] Stream client gone after ${min} min: ${req.socket.remoteAddress} (${clients.size} active)`);
    });
    return;
  }
  if (url.pathname === '/input' && req.method === 'POST') {
    if (!TOUCH) { res.writeHead(403); return res.end('Touch is off (--no-touch)'); }
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      if (!httpInputLogged) { httpInputLogged = true; console.log('[touch] first gesture received via HTTP'); }
      try { const evs = JSON.parse(raw); (Array.isArray(evs) ? evs : [evs]).forEach(handleInput); } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ touch: TOUCH }));
  }
  if (url.pathname === '/keepawake.mp4') {
    // Tiny black looping video: active media playback keeps many devices awake.
    const vid = fs.readFileSync(path.join(__dirname, 'keepawake.mp4'));
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : vid.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${vid.length}`, 'Content-Length': end - start + 1 });
      return res.end(vid.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': vid.length });
    return res.end(vid);
  }
  if (url.pathname === '/frame.jpg') {
    if (!latestFrame) { res.writeHead(503); return res.end('no frame yet'); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': latestFrame.length });
    return res.end(latestFrame);
  }
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ frames: frameCount, clients: clients.size, bytes: latestFrame ? latestFrame.length : 0 }));
  }
  res.writeHead(404); res.end('404');
});

// Every part ends with the next boundary. Browsers show a part only once its closing
// boundary arrives, so without this the screen would lag one frame behind, and with
// only changed frames the last change would stay invisible until the next one.
function onFrameTo(res, frame) {
  res.write(`Content-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n--frame\r\n');
}

// ---------- Touch via WebSocket (one persistent connection instead of an HTTP request per gesture) ----------
// Minimal WebSocket server without npm packages: handshake + read text frames from the client.
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const wsKey = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !wsKey || !TOUCH || (isRemote(req) && url.searchParams.get('k') !== KEY)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  console.log(`\n[touch] WebSocket connected: ${req.socket.remoteAddress}`);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { socket.destroy(); return; } // we never send messages that large
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }            // close
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; } // ping -> pong
      if (op === 0x1) {
        if (!socket._loggedFirst) { socket._loggedFirst = true; console.log('[touch] first gesture received via WebSocket'); }
        try { const evs = JSON.parse(payload.toString()); (Array.isArray(evs) ? evs : [evs]).forEach(handleInput); } catch (e) {}
      }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => console.log('\n[touch] WebSocket disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSource: ${SOURCE}${SOURCE === 'ddagrab' ? ' (monitor ' + DISPLAY + ')' : ''}, ${FPS} fps, ${TARGET ? 'output ' + TARGET : 'width ' + SCALE}`);
  if (!TUNNEL && !PUBLIC_URL) {
    console.log('Open on the Echo Show in the Silk browser:');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log(`   http://${ni.address}:${PORT}/`);
      }
    }
  }
  console.log('');
  if (PUBLIC_URL) { updateSkillEndpoint(PUBLIC_URL); console.log(`[skill] Test in a browser: ${PUBLIC_URL}/?k=${KEY}`); }
  else if (TUNNEL) startTunnel();
  if (TOUCH) startInputHelper();
  startCapture();
});

// fps display in the console
let lastCount = 0;
setInterval(() => {
  const fps = (frameCount - lastCount) / 5; lastCount = frameCount;
  if (!deploying && (fps > 0 || clients.size)) process.stdout.write(`\r[status] ${fps.toFixed(1)} fps, ${clients.size} Client(s)     `);
}, 5000).unref();

process.on('SIGINT', () => { if (ff) ff.kill(); process.exit(0); });
