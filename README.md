# Echo Show as a second Windows monitor

**"Alexa, open second screen"** turns an Amazon Echo Show into an extra monitor for a Windows PC. It's a real **extended desktop**, not mirroring, and **touch goes back to Windows**.

https://github.com/user-attachments/assets/c93661e0-541c-4ed2-a0f9-a2f4e9cc082f

> **Not a skill from the Alexa Skill Store.** It's a private developer skill: you deploy it to your own Amazon developer account, and it runs in development mode on your own Echo devices only (same Amazon account). No certification, no publishing, nothing to install from the store.

> A weekend hack, not a product. Tested on my 1280×800 Echo Show and a Windows laptop. Wouldn't recommend it as a gaming display, even though it technically runs on Amazon's *Web API for Games*.

## What it does

- Windows gets a **virtual monitor** (an indirect display driver). You drag windows onto it like onto any other screen.
- A tiny Node.js server captures that monitor with ffmpeg and streams it to the Echo Show.
- You start it by voice through a custom Alexa skill in developer mode. **No Lambda:** your PC is the skill backend, reached through a Cloudflare tunnel.
- **Touch:** tap = click, drag = drag, hold = right click, two fingers = scroll. A keyboard button opens the Windows on-screen keyboard on the Echo.
- **Only changed frames are sent.** An idle desktop costs almost no bandwidth.
- A hidden, muted looping video keeps the Echo from going to sleep.
- **Zero npm dependencies.** Node, ffmpeg, cloudflared and the ASK CLI are all you need.
- No jailbreak, no sideloading, nothing modified on the Echo.


## How it works

```
"Alexa, open second screen"
        │
Alexa cloud ──HTTPS──► Cloudflare tunnel ──► server.js (your PC)
                                               │ replies: Alexa.Presentation.HTML.Start
                                               ▼
Echo Show (Chromium web view) ◄── MJPEG stream ── ffmpeg ddagrab ◄── virtual monitor
        │
        └── touch ──WebSocket──► server.js ──► PowerShell helper ──► Windows mouse
```

## Two versions

Each folder is self-contained. Start with the Silk version, it proves the hard part in ten minutes.

| Folder | What you get | Needs |
|---|---|---|
| [`silk-browser`](silk-browser/README.md) | Extended desktop in the Echo's Silk browser over your LAN | Virtual display driver, ffmpeg 6+, Node 18+ |
| [`web-api-for-games`](web-api-for-games/README.md) | Started by voice ("Alexa, open second screen"), with touch, drag, right click and scroll back to Windows | + cloudflared, ASK CLI, Amazon developer account |
| [`driver`](driver/vdd_settings.xml) | Driver settings with the Echo resolutions | |

## Quick start

1. Install the virtual display driver, step by step as described in [Installing the virtual display driver](#installing-the-virtual-display-driver) below, and set the new monitor to *Extend* at your Echo's resolution.
2. `winget install Gyan.FFmpeg Cloudflare.cloudflared`, then `npm install -g ask-cli` and `ask configure` (no AWS account needed).
3. Start everything:
   ```
   cd web-api-for-games
   .\start.cmd
   ```
   That's it. On the first start the server finds the virtual monitor by its Echo resolution and remembers it in `monitor.json`. It also starts the Cloudflare tunnel, deploys the skill and turns touch on. Options like `--no-touch` or `--no-tunnel` are listed at the top of [`server.js`](web-api-for-games/server.js).
4. Wait until the console shows the green **READY** box (about a minute), then say **"Alexa, open second screen"**. The skill also understands other languages, depending on your Echo's language:

   | Language | Locales | Say |
   |---|---|---|
   | English | en-US, en-GB, en-CA, en-AU, en-IN | "Alexa, open second screen" |
   | German | de-DE | "Alexa, öffne zweiten Bildschirm" |
   | French | fr-FR, fr-CA | "Alexa, ouvre deuxième écran" |
   | Spanish | es-ES, es-MX, es-US | "Alexa, abre segunda pantalla" |
   | Italian | it-IT | "Alexa, apri secondo schermo" |
   | Portuguese | pt-BR | "Alexa, abra segunda tela" |
   | Dutch | nl-NL | "Alexa, open tweede scherm" |

   The app itself (console, web page) stays in English, only Alexa's spoken replies follow the Echo's language.

## Installing the virtual display driver

Windows needs a monitor that doesn't exist. The open-source [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) provides one. You only do this once.

> **Don't use the winget package.** `winget install VirtualDrivers.Virtual-Display-Driver` finished without errors on my machine, but no driver was installed. The manual install below works.

### 1. Download the driver

Go to the [releases page](https://github.com/VirtualDrivers/Virtual-Display-Driver/releases) and download `VirtualDisplayDriver-x64.zip` (tested with release 24.10.27).

### 2. Unzip it

Unzip the contents to a folder of your choice. The simplest choice is `C:\VirtualDisplayDriver\`, because that's where the driver looks for its settings by default (see step 3). You need the folder for steps 4 and 5.

### 3. Add the Echo resolutions

Copy [`driver/vdd_settings.xml`](driver/vdd_settings.xml) from this repo to `C:\VirtualDisplayDriver\vdd_settings.xml` (create the folder if it doesn't exist) and replace any existing file. It adds the resolutions of all Echo Show models.

The driver reads `vdd_settings.xml` only from one folder: the path stored in the registry value `HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver\VDDPATH`, or `C:\VirtualDisplayDriver\` if that value doesn't exist. A manual install doesn't create the registry value, so the default applies. If the folder or file is missing, your settings are silently ignored.

**Want another folder?** Put `vdd_settings.xml` there and run `driver\vdd.cmd path D:\Your\Folder` once (after step 5). It writes the registry value and restarts the driver. `driver\vdd.cmd path` shows which folder is in use. An environment variable doesn't work here: the driver runs as a Windows service and only reads the registry.

### 4. Install the certificate: run `installCert.bat` as administrator

In the folder from step 2, right-click `installCert.bat` → **Run as administrator** and confirm the UAC prompt. The driver is signed with its own certificate, and Windows only accepts it once that certificate is installed.

**Don't skip this step.** Without it, the next step fails with *"An error occurred"*.

### 5. Install the driver in Device Manager

1. Press `Win + R`, type `devmgmt.msc` and press Enter.
2. Click the top entry (your computer's name), so the menu shows all options.
3. **Action → Add legacy hardware** (German Windows: *Aktion → Legacyhardware hinzufügen*). Click **Next**.
4. Choose **Install the hardware that I manually select from a list (Advanced)** → **Next**.
5. Select **Display adapters** → **Next**.
6. Click **Have Disk…** → **Browse…**, select `MttVDD.inf` from the folder from step 2 → **Open** → **OK**.
7. Select **Virtual Display Driver** → **Next** → **Next**. If Windows asks whether to install the driver, confirm.
8. Click **Finish**.

### 6. Check that it worked

Under **Display adapters** in Device Manager there's now a *Virtual Display Driver* without a warning sign. In PowerShell:
```
Get-PnpDevice -Class Display | Format-Table Status, FriendlyName
```
should list it with status `OK`.

### 7. Set up the monitor in Windows

Open **Settings → System → Display**. You'll see an additional monitor.
- Select it and set **Multiple displays** to **Extend these displays** (not *Duplicate*).
- Set **Display resolution** to your Echo's resolution (see [Supported devices](#supported-devices)).
- Drag it to where it should sit relative to your other screens.

**If a resolution is missing:** check with `driver\vdd.cmd path` which folder the driver uses and that its `vdd_settings.xml` is the file from this repo, then switch the driver off and on with `driver\vdd.cmd off` and `driver\vdd.cmd on`, or restart Windows.

## Turning the virtual monitor on and off

When you don't use the Echo, Windows still has the extra monitor and windows can end up there. Switch it off and on again with:

```
driver\vdd.cmd off
driver\vdd.cmd on
driver\vdd.cmd status
driver\vdd.cmd path                 # which folder vdd_settings.xml is read from
driver\vdd.cmd path D:\Your\Folder  # use another folder
```

It asks for admin rights (UAC) and disables or enables the driver in Device Manager. Windows remembers the monitor's position and resolution.

You don't have to turn it on by hand: `start.cmd` checks the driver at start and turns it on if it's off (one UAC prompt). Stopping the server leaves the monitor on. Skip the check with `--no-vdd`.

## Supported devices

| Device | Resolution | Status |
|---|---|---|
| Echo Show 8 (gen 1–3), Echo Show 10, Echo Show 2nd gen | 1280 × 800 | tested (1280×800 model) |
| Echo Show 8 (4th gen, 2025) | 1340 × 800 | untested |
| Echo Show 11 (2025) | 1920 × 1200 | untested |
| Echo Show 15 / 21 | 1920 × 1080 | untested |
| Echo Show 1st gen (2017) | 1024 × 600 | untested |
| Echo Show 5 (all gens) | 960 × 480 | untested |

All of these resolutions are already in [`driver/vdd_settings.xml`](driver/vdd_settings.xml). Set the virtual monitor to your Echo's resolution, and the server detects it automatically.

Windows only for now. macOS would need a different virtual display and capture path.

## Limitations

- **Latency and frame rate** are fine for chat, email, dashboards or music controls. Not for games or video.
  The Echo isn't the bottleneck, it only shows JPEGs. Most of the lag is the network: Alexa skills need a public HTTPS URL, so every frame goes from your PC through the Cloudflare tunnel and back to the Echo. The [Silk version](silk-browser/README.md) stays in your LAN and skips that round trip.
- The PC has to run the server while you use the screen.
- Free Cloudflare quick tunnels get a new URL on every start, so the server re-deploys the skill each time (about a minute). A named tunnel with your own domain avoids that.
- Alexa web apps end after at most 30 minutes without interaction. Whether the built-in keep-alive extends that is still being tested.
- The skill start occasionally fails with "There was a problem with the requested skill's response". Saying it again usually works.
- No pinch zoom. Typing works through the Windows on-screen keyboard, which is fine for short text only.
- Windows running as administrator ignore the touch clicks unless the server also runs as administrator.

## Security

- While the tunnel runs, your screen is reachable from the internet. Every request through the tunnel needs a random key, generated on each start (or fixed with `--key`).
- Touch is on by default: anyone with URL **and** key can control your mouse on the virtual monitor. Only use it on your own devices, or start with `--no-touch`.
- The skill endpoint does not verify Alexa request signatures. That's fine for a private dev skill, but required before publishing.

## Credits

- [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) by the VirtualDrivers project
- [FFmpeg](https://ffmpeg.org/) and its `ddagrab` filter
- [Alexa Web API for Games](https://developer.amazon.com/en-US/docs/alexa/web-api-for-games/alexa-games-about.html)

## License

MIT
