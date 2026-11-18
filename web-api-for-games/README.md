# Web API for Games: "Alexa, open second screen", with touch

The full version: a custom Alexa skill opens the second monitor on the Echo Show (via Alexa's Web API for Games), and with `--touch` **the Echo's touchscreen controls the Windows mouse.** The skill part is described further down.

| Gesture on the Echo | Effect in Windows |
|---|---|
| Tap | Left click |
| Drag | Drag with the left button held (move windows, select text) |
| Hold for 0.6 s | Right click |
| Swipe with two fingers | Mouse wheel (scrolling) |

```
Echo: touch ──WebSocket /ws {t,x,y} (fallback: POST /input)──► server.js ──stdin──► PowerShell helper ──SetCursorPos/mouse_event──► Windows
```

## Start with touch

The skill setup is described below under "Alexa, open second screen". Then add `--touch`:
```
.\start.cmd --adapter 1 --display 0 --target 1280x800 --touch --tunnel --tunnel-protocol http2
```
Wait for `[skill] Deploy done`, then talk to Alexa.
On the LAN via Silk, without the skill, this works too: `.\start.cmd --adapter 1 --display 0 --target 1280x800 --touch`

At startup the console lists all monitors and prints `[touch] controlling monitor N: … 1280x800 at X,Y`. That has to be the virtual monitor. It is detected via the `--target` resolution; otherwise pick it with `--input-monitor N`.

## Debugging touch

- `[touch] WebSocket connected` → the page opened the fast channel.
- `[touch] first gesture received via WebSocket` / `via HTTP` → gestures arrive (HTTP is the fallback).
- `[touch] gesture received, but the mouse helper is not running` → the PowerShell helper failed, see the messages above it.
- Append `&ws=0` to the page URL to force HTTP and rule out WebSocket problems.

## Limits and security

- **Touch is remote control of your PC.** That's why it is only active with `--touch`, and through the tunnel only with the key `k`. Anyone with the URL plus key can move and click your mouse on the virtual monitor.
- Windows running as administrator ignore the clicks (Windows UIPI protection) unless you start the server as administrator too.
- No pinch zoom and no keyboard.
- Latency: touch runs over one persistent WebSocket (no npm package), but the internet round trip through the tunnel remains. Biggest remaining lever: load picture and touch directly over LAN HTTPS with your own domain.
- Different Windows scaling per monitor (e.g. laptop at 125 %) is handled: monitor list and mouse helper are per-monitor DPI aware.

---

# "Alexa, open second screen"

Instead of opening Silk by hand, a custom Alexa skill starts the second monitor. The twist: there is **no Lambda**. Your PC is the skill backend.

```
"Alexa, open second screen"  /  "Alexa, öffne zweiten Bildschirm"
   │
Alexa cloud ──HTTPS──► Cloudflare tunnel ──► server.js  POST /alexa
   │                                             │  replies with Alexa.Presentation.HTML.Start
   ▼                                             ▼
Echo Show opens https://…trycloudflare.com/?alexa=1&k=…  (Web API for Games, Chromium web view)
   └── shows /stream.mjpg (your virtual monitor), keep-awake video, keep-alive pings to the skill
```

The skill speaks English (en-US, en-GB) and German (de-DE); the reply language follows the Echo's language.

## Requirements

- The [Silk browser version](../silk-browser/README.md) works (virtual monitor, ffmpeg, `--adapter 1 --display 0`).
- `cloudflared` in PATH. Check with `cloudflared --version`, otherwise `winget install Cloudflare.cloudflared`.
- ASK CLI v2: `npm install -g ask-cli`, then `ask configure` once (browser login; answer **No** to linking an AWS account). The developer account must be the same Amazon account your Echo Show is registered to.

## Start

**In the `web-api-for-games` folder** (without touch; add `--touch` for touch):
```
.\start.cmd --adapter 1 --display 0 --target 1280x800 --tunnel --tunnel-protocol http2
```
The server starts the tunnel, prints the public URL, writes it into `skill-package\skill.json` and then runs `ask deploy --ignore-hash` by itself. Wait for `[skill] Deploy done` (about a minute). The first deploy creates the skill, uploads the language models and enables it for testing in the development stage. No certification needed. Turn the automatic deploy off with `--no-deploy`.

**Then:** "Alexa, open second screen" (English Echo) or "Alexa, öffne zweiten Bildschirm" (German Echo). End with "Alexa, stop".

Test first: the console prints `Test in a browser: https://…trycloudflare.com/?k=…`. If that loads on your phone over mobile data, the tunnel works.

## Annoying: the quick tunnel URL changes on every start

The server re-deploys the skill on every start, which takes about a minute. Keep the server running while testing. For a fixed URL use a named Cloudflare tunnel with your own domain (`cloudflared tunnel create …`) and start the server with
```
.\start.cmd --adapter 1 --display 0 --target 1280x800 --public-url https://screen.yourdomain.com --key MYSECRET
```
Then one `ask deploy` is enough.

## Security

- While the tunnel runs, your screen is reachable from the internet. That's why every request through the tunnel needs the key `k`. It is generated on every start unless you fix it with `--key`. On the LAN it works without the key.
- The skill endpoint does not verify the signature of Alexa requests. Fine for a dev skill on your own account, mandatory for publishing. Worst case, someone with the URL can trigger the screen start but sees nothing without the key.

## What the console logs (good material for the blog)

- `Alexa: LaunchRequest` etc.: every request from the Alexa cloud.
- `Alexa: Alexa.Presentation.HTML.Message`: the page's keep-alive, once a minute.
- `Alexa: SessionEndedRequest (REASON)`: **why** Alexa closed the web app. Per Amazon's docs it ends after at most 30 minutes without interaction. Whether the keep-alive extends that is untested.
- `Stream client gone after X min`: how long the picture ran.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Alexa says the skill's response had a problem | No `Alexa: LaunchRequest` in the console → the skill still has an old tunnel URL. Wait for `[skill] Deploy done`, or look for `Deploy FAILED` and run `ask deploy --ignore-hash` yourself. Check Build → Endpoint in the developer console. |
| `DNS_PROBE_FINISHED_NXDOMAIN` for the tunnel URL | Tunnel not connected yet, or DNS cached too early: watch for `[cloudflared] Registered tunnel connection`, use `--tunnel-protocol http2`, `ipconfig /flushdns`. |
| `ask` not found | `npm install -g ask-cli`, then `ask configure`. |
| Alexa does not open the skill | Echo language matches a skill locale? Same Amazon account as the developer console? |
| Page opens but stays black | MJPEG gets buffered through the tunnel: start with `--skill-mode poll`. |
| "403: key missing" | URL opened without `?k=…`. The right URL is in the console. |
