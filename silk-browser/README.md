# Silk browser: Echo Show as a second Windows monitor (LAN, no skill)

Goal: an **extended** Windows desktop shows up live on the Echo Show. No skill, just the browser.

```
Windows: virtual monitor ──ddagrab──► ffmpeg (MJPEG) ──► server.js :8080 ──LAN/HTTP──► Silk on the Echo Show
```

## One-time setup

1. **ffmpeg 6 or newer (needed for `ddagrab`)**
   `winget install Gyan.FFmpeg`, then open a new terminal and check `ffmpeg -version`.
   If an older ffmpeg comes first in your PATH, `server.js` automatically picks the winget build.
2. **Virtual monitor:** install the virtual display driver step by step as described in the [main README](../README.md#installing-the-virtual-display-driver). Short version: unzip the driver, copy `..\driver\vdd_settings.xml` to `C:\VirtualDisplayDriver\` (or another folder set with `..\driver\vdd.cmd path`), run `installCert.bat` **as administrator**, then *Add legacy hardware* in Device Manager with `MttVDD.inf`. Then in Display settings set the new monitor to "Extend" and to the Echo's resolution:

   | Device | Display |
   |---|---|
   | Echo Show 5 (all gens) | 960 × 480 |
   | Echo Show 1st gen | 1024 × 600 |
   | Echo Show 8 (gen 1–3) / 10 / 2nd gen | 1280 × 800 |
   | Echo Show 8 (4th gen, 2025) | 1340 × 800 |
   | Echo Show 15 / 21 | 1920 × 1080 |
   | Echo Show 11 (2025) | 1920 × 1200 |

   The driver reads its settings from `C:\VirtualDisplayDriver\vdd_settings.xml` unless another folder is set with `..\driver\vdd.cmd path`. If a new resolution does not show up after a change, restart Windows.
3. **Node.js 18 or newer.** No other packages needed.

## Start

```
.\start.cmd --source test   # 1. test pattern: checks network + Echo Show, no screen capture
.\start.cmd                 # 2. the real thing
```

In PowerShell always prefix with `.\` (or call `node server.js …` directly).
The server prints the URL, e.g. `http://192.168.1.50:8080/`.
Windows asks about the firewall on first start. Allow **private networks**.

On the first start the server finds the virtual monitor by its Echo resolution and saves it in `monitor.json`. `ddagrab` only sees the monitors of one GPU, so it tries every GPU/monitor combination (`--probe` lists them). After changing the resolution, start once with `--redetect`. To pick by hand: `--adapter N --display N --target WxH`.

## On the Echo Show

1. "Alexa, open Silk" (or "Alexa, open the browser")
2. Type the URL and tap the page once. It switches to fullscreen and starts the keep-awake video.
3. Drag a window onto the virtual monitor. Done, that's your second screen.

If the stream stutters or stalls: `http://…:8080/?mode=poll&fps=8`. The page then fetches single JPEGs instead of holding an MJPEG stream.

## Tuning

| Option | Default | Effect |
|---|---|---|
| `--target 1280x800` | detected | exact output size; keeps the aspect ratio, pads with black |
| `--fps 15` | 10 | more frames per second, more CPU and Wi-Fi load |
| `--quality 4` | 6 | ffmpeg `-q:v`, lower = sharper and bigger (2 to 31) |
| `--scale 960` | 1280 | target width when `--target` is not set, `0` = original size |
| `--port 9000` | 8080 | |
| `--all-frames` | off | send every frame. By default only frames where the screen changed are sent, so an idle desktop costs almost no Wi-Fi |
| `--ffmpeg C:\tools\ffmpeg.exe` | auto | if ffmpeg is not found |
| `--source gdigrab --monitor N` | – | fallback without `ddagrab` (does **not** work for the virtual monitor, see below) |

Diagnostics: `http://localhost:8080/stats` shows frame count, clients and frame size. `http://localhost:8080/frame.jpg` shows the current frame.

## Pitfalls we hit

- **Old ffmpeg in PATH** (4.3 from 2021) has no `ddagrab` → "No such filter: 'ddagrab'". Fixed by preferring the winget build.
- **`gdigrab` on the virtual monitor** only gives black plus a trail of mouse cursors. GDI cannot see content on indirect display driver monitors, so always use `ddagrab` (the default).
- **Windows scaling (125 %)** makes non-DPI-aware tools report wrong monitor sizes → only a crop gets captured. The server reads monitor bounds DPI aware.
- **Driver install fails** unless `installCert.bat` was run as administrator first.
- **Settings ignored** because `C:\VirtualDisplayDriver` did not exist (the driver was installed from Downloads).

## Keep the Echo awake

The viewer page plays an invisible, muted looping video (`keepawake.mp4`). With it the Echo Show does not go to standby (tested: still on after 36 min). Tap the page once after loading so the video surely starts. Turn it off with `?keepawake=0`.

## Measuring for the blog

- **Latency:** put a stopwatch on the virtual monitor and photograph the Echo Show and the PC monitor together with your phone. The difference is the end-to-end latency.
- **fps:** shown in the server console (`[status] … fps`).
- **Uptime:** the console logs `Stream client gone after X min`. Without the keep-awake video the Echo goes to standby after a while; with it the test ran for over 36 min.

## Known limits

- LAN and plain HTTP only. Fine for Silk. The Alexa skill version in [`web-api-for-games`](../web-api-for-games/README.md) needs public HTTPS, so a Cloudflare tunnel.
- No touch input back to Windows here. The `web-api-for-games` server has it (on by default), and `.\start.cmd --no-tunnel` there gives you the same in Silk on the LAN, with automatic monitor detection.
- One ffmpeg process serves all clients, so several Echo Shows at once work.
