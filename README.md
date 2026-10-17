# Mask Morph

A static web app that takes a selfie, lines your face up with a **Shining Mask** LED mask
(the Heaton "Shining Mask" app's masks), and slowly morphs it into something unrecognizable
on the mask over Bluetooth.

**Live app:** https://levavakian.github.io/mask/ (open in Chrome on Android; on iPhone use the Bluefy browser,
since Safari has no Web Bluetooth).

## Using it

1. Turn the mask on, open the app, and tap **Connect** (the browser will remember the mask and
   reconnect on its own next time where supported).
2. **Photo:** open the camera and take a selfie (or pick one from the gallery). The face is found
   automatically.
3. **Line up:** adjust zoom/position/contrast; **Show on mask** sends one frame to check the fit.
4. **Morph:** pick a style, number of frames (up to 33), strength and color drift.
5. **Play on mask:** **Send frames to mask** uploads every frame, then playback starts.
   Set the speed (whole seconds per frame) and mode (once / back and forth / loop) any time — no re-upload needed.

Uploading takes roughly 5–10 seconds per frame and the mask shows its own download animation meanwhile
(that's firmware behaviour and can't be turned off). Keep the page open during playback: the phone
hands the mask a new list of frames about every 9 seconds.

## Development

The only thing you need installed is [Nix](https://nixos.org/download) (with flakes enabled).

| Command | What it does |
| --- | --- |
| `nix run .#serve` | Serve the site from `docs/` at http://localhost:8000 (`PORT=…` to change) |
| `nix run .#test` | Unit tests: protocol framing, AES, image encoding (Node) |
| `nix run .#e2e` | Headless Chromium run of the app with `tests/fixtures/selfie.jpg`; screenshots go to `tests/out/` (needs internet for the face model) |
| `nix run .#webcam -- photo` | Photo (or video) from the laptop webcam, to check what the mask shows (WSL only, see below) |
| `nix develop` | Shell with node, python, `gh` and ffmpeg |

There is no build step: `docs/` is the site, as plain ES modules. Face landmarks come from
MediaPipe Face Landmarker, loaded from jsDelivr / Google storage at runtime.

### Watching the mask through the webcam

On a Windows laptop running WSL, `nix run .#webcam` takes photos and short videos with the webcam, so
what the mask displays can be checked without someone watching it. It runs `tools/webcam.ps1` in Windows
PowerShell, which uses the camera API built into Windows, so there is nothing to install on either side.

```sh
nix run .#webcam -- list                                       # cameras and sizes
nix run .#webcam -- photo                                      # -> tests/out/webcam/photo-<time>.png
nix run .#webcam -- photo mask.png --exposure -8               # short exposure for the bright LEDs
nix run .#webcam -- video clip.mp4 --seconds 12 --exposure -8  # e.g. to check playback for flicker
nix develop -c ffmpeg -i clip.mp4 -vf "fps=2,scale=480:-1,tile=6x4" -frames:v 1 sheet.png  # contact sheet
```

- Captures default to `tests/out/webcam/` (git-ignored; they can include faces). The camera light is on while capturing.
- Photos are taken, and videos started, once auto-exposure has settled (2–3 s).
- `--exposure` is log2(seconds), -13 to -1. Manual exposures come out much darker than auto (in a dim room
  even -5 is nearly black), which suits the LEDs, and keep video at 30 fps (auto drops to ~20 fps in dim light).
  Auto exposure is put back afterwards.
- If another app is using the camera, the tool shares it read-only: it still captures, but can't change size or exposure.

### Deploying

GitHub Pages serves `docs/` from the `main` branch, so pushing to `main` deploys.
One-time setup (already done for this repo):

```sh
nix run nixpkgs#gh -- api -X POST repos/levavakian/mask/pages -f 'source[branch]=main' -f 'source[path]=/docs'
```

## Layout

- `docs/js/protocol.js` — mask BLE protocol (commands, image format, packets)
- `docs/js/aes.js` — AES-128-ECB on top of WebCrypto
- `docs/js/mask.js` — Web Bluetooth connection, upload and playback commands
- `docs/js/face.js` — face detection and alignment onto the 46×58 LED grid
- `docs/js/morph.js` — morph styles
- `docs/js/player.js` — playback planning (PLAY lists)
- `docs/js/app.js` — UI
- `tools/webcam.ps1` — webcam photos/videos from WSL (`nix run .#webcam`)

## Mask protocol notes

Based on [mask-go](https://github.com/GoneUp/mask-go),
[BrickCraftDream's notes](https://github.com/BrickCraftDream/Shining-Mask-stuff/blob/main/ble-protocol.md) and
[Bishop Fox](https://github.com/BishopFox/shining-mask), and checked against a real mask:

- Service `fff0`; commands to `…9600` (AES-128-ECB, fixed key, 16-byte blocks), replies on `…9601`,
  image data to `…960a` (plain).
- Display is **46 × 58** LEDs (corners not populated). Images are RGB, 3 bytes per LED,
  sent **column by column, top to bottom**.
- Upload: `DATS <size u16> <slot u16> 01` → `DATSOK`; then 100-byte packets
  `[len+1, index, ≤98 bytes]`, each acknowledged with `REOK`; then `DATCP <unix time u32>` → `DATCPOK`.
  The mask drops packets if you don't wait for each `REOK`.
- 34 image slots (1–34). `PLAY <n> <slot…>` (up to 10 slots) shows them, cycling on the mask's own
  timer at ~1 slot per second; the `SPEED` command does not change that rate.
- Every `PLAY` command causes a visible flicker / bright column, but cycling within one list is clean.
  So playback sends lists of up to 10 slots (frames repeated for slower speeds) instead of one `PLAY` per frame.
- The mask plays a download animation during every upload, even at brightness 0. Sending any command
  mid-upload (e.g. `PLAY` to hide the animation) corrupts the stored image, so frames are uploaded first and played after.
