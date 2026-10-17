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
   Set the speed (seconds per frame) and mode (once / back and forth / loop) any time — no re-upload needed.

Uploading takes a few seconds per frame and the mask shows its own download animation meanwhile.
Keep the page open during playback; the phone drives the frame changes.

## Development

The only thing you need installed is [Nix](https://nixos.org/download) (with flakes enabled).

| Command | What it does |
| --- | --- |
| `nix run .#serve` | Serve the site from `docs/` at http://localhost:8000 (`PORT=…` to change) |
| `nix run .#test` | Unit tests: protocol framing, AES, image encoding (Node) |
| `nix run .#e2e` | Headless Chromium run of the app with `tests/fixtures/selfie.jpg`; screenshots go to `tests/out/` (needs internet for the face model) |
| `nix develop` | Shell with node, python and `gh` |

There is no build step: `docs/` is the site, as plain ES modules. Face landmarks come from
MediaPipe Face Landmarker, loaded from jsDelivr / Google storage at runtime.

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
- `docs/js/app.js` — UI

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
- 34 image slots (1–34). `PLAY <n> <slot…>` shows slots (cycling ~1 fps if several). Switching takes ~60 ms.
- The mask plays a download animation during every upload. Sending any command mid-upload
  (e.g. `PLAY` to hide the animation) corrupts the stored image, so frames are uploaded first and played after.
