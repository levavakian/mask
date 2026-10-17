# Firmware / hot-swap investigation

**Question explored:** can we replace the mask firmware so new frames upload *without* the
"download" animation taking over the screen — i.e. hot-swap a new animation while the current
one keeps playing?

## Outcome

**Not achievable on this mask without firmware we can't currently build or flash safely.**

1. The download animation is unconditional firmware behavior on every BLE upload; there is no
   command or flag over the documented `fff0` service that suppresses it.
2. Replacing the firmware is blocked on *this* hardware: there is no firmware image for it (to
   modify or to recover with), the OTA service doesn't respond, and there is no recovery path —
   so a flash would risk an unrecoverable brick. **No firmware write was performed.**

## What this mask is

- BLE name `MASK-33xxxx`. Hardware model string — `fff0` command char (`…9600`), descriptor
  `0x2901` — is **`TR2111R004-01`**.
- GATT services: `fff0` (control + image upload, documented in the README), `fd00` (Panchip OTA:
  `fd01` data, `fd02` ctrl), `ae00` (`ae01` write, `ae02` notify — **not used by the app**), `1800` (GAP).
- Display confirmed **46×58, column-major RGB, 8004 B/frame** by uploading a left-red / right-blue
  split and seeing a clean vertical split on the panel.
- The firmware **composites a fixed face (eyes + nose) over DIY images** — a solid-colour upload
  shows the colour with a white "nose" and dark eye cut-outs that are not in the uploaded data.
  (Side observation; worth a follow-up for the web app's rendering, not related to hot-swap.)

## Download animation is unavoidable over BLE

Verified on the device with the webcam:

- Uploading with the `DATS` trailing flag byte `= 0` vs `= 1` shows the **identical** animation —
  the flag does not control it.
- Every app upload path uses `DATS` per frame (single DIY, scrolling text, and the multi-image
  `MANY` batch mode all call the same `DATS`→packets→`DATCP` sequence), so all of them animate.
- Interleaving `PLAY` during an upload corrupts the stored frame (earlier finding) and does not
  hide the animation.
- **`PLAY` itself is NOT disruptive:** switching which stored slots cycle is instant and
  animation-free (a held solid colour shows no "downloading" state).

**Best safe approach to the spirit of the goal:** preload animations into the 34 slots (accept the
one-time download animation while loading), then switch between them instantly with `PLAY`. The
shipped dedup upload (identical frames share one slot) stretches the slot budget.

## Why firmware replacement is blocked + unsafe here

- The official app (`cn.com.heaton.shiningmask`, latest **1.2.7**) bundles firmware **only** for
  hardware **`TR1906R04`** (`assets/TR1906R04-*_OTA.bin`). This mask is **`TR2111R004-01`**.
  No `TR2111R004` firmware exists in the app or anywhere public.
- The Panchip OTA service (`fd00`/`fd02`) does **not** answer the documented version request in
  normal operation; no "enter OTA/DFU" trigger was found, and the app never touches `ae00`.
- So: no base image to modify, no recovery image, and flashing the mismatched `TR1906R04` image
  onto `TR2111R004` hardware would very likely brick it with no way back. Given the hard
  "don't brick it / don't get locked out" constraint, nothing was flashed.

## Panchip OTA protocol (decompiled from the app, for reference)

Over service `fd00`: enable notify on `fd02`, then on `fd02`:

| step | write (ctrl `fd02`) | device reply |
|------|--------------------|--------------|
| version | `01` + 6-byte version | `80 01 <app lo hi><dev lo hi><pro lo hi>` |
| size | `02 <type> <codeSize u32 LE>` | `80 02 00` (ok) |
| data | → `fd01`: 2-byte header + (MTU−3−2)-byte chunks | `80 04` per chunk (ack) |
| crc | `03 <crc32>` | `80 03 00` (success) → device reboots |

The `.bin` is a 16-byte header `[codeSize u32 LE][crc32][version 6B][type][_]` + code. The CRC is
the value already stored in that header, so **re-flashing a stock image needs no CRC math**; a
*modified* image needs its (custom, non-standard — not zlib/BZIP2/etc.) Panchip CRC recomputed.
Firmware is **not encrypted** (XOR of the two official versions has long exact-zero runs), so it is
modifiable in principle.

## To unblock safely (future)

Get the **`TR2111R004-01`** firmware image from the vendor (Shenzhen Heaton / `e-toys.cn`). That
provides both a modification base and a recovery image; then the `fd00` OTA can be driven from a
bleak client, proving a **stock re-flash first** before any modified image.
