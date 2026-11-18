// Silk browser version: a Windows monitor as an MJPEG stream for the Silk browser on the Echo Show.
// No npm dependencies. Needs Node >= 18 and ffmpeg >= 6.
//
//   node server.js                      -> captures monitor 1 (second monitor) with ddagrab
//   node server.js --display 0          -> another monitor (0 = usually the main one)
//   node server.js --source test        -> test pattern instead of the screen (for trying things out)
//   node server.js --source gdigrab --offset-x 1920 --width 1280 --height 800
//                                       -> fallback without ddagrab
//   node server.js --source gdigrab --monitor 2 --target 1280x800
//                                       -> detect the monitor automatically (list at startup) and
//                                          scale exactly to the Echo resolution (black bars if needed)
//   More options: --port 8080 --fps 10 --quality 6 --scale 1280

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

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
const DISPLAY = opt('display', '1');
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
const TARGET = opt('target', '');                  // e.g. 1280x800 = exact output size for the Echo Show
const MONITOR = opt('monitor', '');
const ADAPTER = opt('adapter', '0');                // DXGI adapter (GPU) for ddagrab

// Read monitors via PowerShell. DPI-aware so the values are real pixels
// (otherwise Windows reports scaled-down values at 125/150 % -> only a crop gets captured).
function listMonitors() {
  if (process.platform !== 'win32') return [];
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiFix{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}';` +
    `[DpiFix]::SetProcessDPIAware() | Out-Null; Add-Type -AssemblyName System.Windows.Forms;` +
    `[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0};{1};{2};{3};{4};{5}' -f $_.DeviceName,$_.Primary,$_.Bounds.X,$_.Bounds.Y,$_.Bounds.Width,$_.Bounds.Height }`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' });
    return out.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const [name, primary, x, y, w, h] = line.trim().split(';');
      return { nr: i + 1, name, primary: primary === 'True', x: +x, y: +y, w: +w, h: +h };
    });
  } catch (e) {
    console.error('[monitors] could not be read:', e.message);
    return [];
  }
}

// --probe: try every combination of GPU (adapter) and monitor (display)
if (args.includes('--probe')) {
  const { spawnSync } = require('child_process');
  console.log(`Testing ddagrab with ${FFMPEG} ...\n`);
  for (let a = 0; a < 4; a++) {
    for (let d = 0; d < 4; d++) {
      const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'verbose',
        '-init_hw_device', `d3d11va=dda:${a}`, '-filter_hw_device', 'dda',
        '-filter_complex', `ddagrab=output_idx=${d}:framerate=5,hwdownload,format=bgra`,
        '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000 });
      const log = (r.stderr || '') + (r.stdout || '');
      const m = log.match(/Opened dxgi output \d+ with dimensions (\d+)x(\d+)/);
      if (m) console.log(`  --adapter ${a} --display ${d}  ->  ${m[1]}x${m[2]}`);
    }
  }
  console.log('\nPick the entry with the virtual monitor\'s resolution, e.g.:');
  console.log('  .\\start.cmd --adapter 1 --display 0 --target 1280x800');
  process.exit(0);
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
      '-filter_complex', `ddagrab=output_idx=${DISPLAY}:framerate=${FPS}:draw_mouse=1,hwdownload,format=bgra${scale}`,
      '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', String(QUALITY), '-f', 'mjpeg', 'pipe:1'];
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
    '-vf', vf, '-pix_fmt', 'yuvj420p', '-c:v', 'mjpeg', '-q:v', String(QUALITY),
    '-f', 'mjpeg', 'pipe:1'];
}

// ---------- Capture: ffmpeg writes JPEGs back to back to stdout ----------
let latestFrame = null;
let frameCount = 0;
const clients = new Set();
let ff = null;

function startCapture() {
  const a = ffmpegArgs();
  console.log('[ffmpeg]', FFMPEG, a.join(' '));
  ff = spawn(FFMPEG, a, { stdio: ['ignore', 'pipe', 'inherit'] });
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

function onFrame(frame) {
  latestFrame = frame;
  frameCount++;
  for (const res of clients) {
    // Slow clients skip frames instead of building up buffers (low latency).
    if (res.writableNeedDrain) continue;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write('\r\n');
  }
}

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

function onFrameTo(res, frame) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
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
