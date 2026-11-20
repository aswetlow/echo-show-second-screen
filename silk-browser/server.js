// Silk browser version: a Windows monitor as an MJPEG stream for the Silk browser on the Echo Show.
// No npm dependencies. Needs Node >= 18 and ffmpeg >= 6.
//
//   node server.js (or start.cmd) finds the virtual monitor automatically (first start only,
//   saved in monitor.json) and streams it at its own resolution.
//
// Options (all optional):
//   --no-vdd              don't turn the virtual monitor on at start if it's off
//   --redetect            search the virtual monitor again (e.g. after changing its resolution)
//   --probe               list every GPU/monitor combination and exit
//   --adapter N --display N --target WxH   pick the monitor by hand
//   --source test         test pattern instead of the screen (checks network + Echo Show)
//   --source gdigrab --monitor 2 --target 1280x800   fallback without ddagrab (not for virtual monitors)
//   --all-frames          send every frame (default: only frames where the screen changed)
//   --port 8080 --fps 10 --quality 6 --scale 1280

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
// Without this, PowerShell prints its progress bar ("Preparing modules for first use") as CLIXML.
const PS_QUIET = "$ProgressPreference = 'SilentlyContinue'; ";

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
let ADAPTER = opt('adapter', '');                  // DXGI adapter (GPU) for ddagrab; empty = auto-detect

// Read monitors via PowerShell. DPI-aware so the values are real pixels
// (otherwise Windows reports scaled-down values at 125/150 % -> only a crop gets captured).
function listMonitors() {
  if (process.platform !== 'win32') return [];
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiFix{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}';` +
    `[DpiFix]::SetProcessDPIAware() | Out-Null; Add-Type -AssemblyName System.Windows.Forms;` +
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSource: ${SOURCE}${SOURCE === 'ddagrab' ? ' (monitor ' + DISPLAY + ')' : ''}, ${FPS} fps, ${TARGET ? 'output ' + TARGET : 'width ' + SCALE}`);
  console.log('Open on the Echo Show in the Silk browser:');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`   http://${ni.address}:${PORT}/`);
    }
  }
  console.log('');
  startCapture();
});

// fps display in the console
let lastCount = 0;
setInterval(() => {
  const fps = (frameCount - lastCount) / 5; lastCount = frameCount;
  if (fps > 0 || clients.size) process.stdout.write(`\r[status] ${fps.toFixed(1)} fps, ${clients.size} Client(s)     `);
}, 5000).unref();

process.on('SIGINT', () => { if (ff) ff.kill(); process.exit(0); });
