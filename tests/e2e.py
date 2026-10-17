"""Headless browser check of the web app (no Bluetooth).

Loads docs/ in Chromium, feeds the selfie fixture through the "From gallery" input,
waits for face detection and morph frames, and writes screenshots to tests/out/.
Run with: nix run .#e2e
"""
import base64
import os
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
FIXTURE = ROOT / "tests" / "fixtures" / "selfie.jpg"

SHEET_JS = """
async () => {
  const { STYLES, renderFrame, prepareMorph } = await import('./js/morph.js');
  const { state } = window.maskApp;
  const ts = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const styles = Object.keys(STYLES);
  const S = 4, W = 46, H = 58, pad = 6;
  const c = document.createElement('canvas');
  c.width = ts.length * (W * S + pad); c.height = styles.length * (H * S + pad);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, c.width, c.height);
  const m = prepareMorph(state.face, state.seed);
  styles.forEach((style, r) => ts.forEach((t, k) => {
    const img = renderFrame(m, t, { style, intensity: 1, colorDrift: 0.35 });
    const tmp = new OffscreenCanvas(W, H); tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, k * (W * S + pad), r * (H * S + pad), W * S, H * S);
  }));
  return c.toDataURL('image/png');
}
"""


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    handler.func.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    OUT.mkdir(exist_ok=True)
    server = serve()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ["CHROMIUM"], args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 412, "height": 900}, device_scale_factor=2)
        page.on("console", lambda m: print(f"[console.{m.type}] {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.screenshot(path=str(OUT / "01-start.png"), full_page=True)

        page.set_input_files("#fileInput", str(FIXTURE))
        try:
            page.wait_for_function("window.maskApp?.state.frames.length > 0", timeout=90_000)
        except Exception:
            print("photo status at timeout:", page.inner_text("#photoStatus"), errors)
            page.screenshot(path=str(OUT / "timeout.png"), full_page=True)
            raise
        status = page.inner_text("#photoStatus")
        print("photo status:", status)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "02-loaded.png"), full_page=True)
        page.locator("#alignCard").screenshot(path=str(OUT / "03-align.png"))
        page.locator("#morphCard").screenshot(path=str(OUT / "04-morph.png"))

        sheet = page.evaluate(SHEET_JS)
        (OUT / "05-styles.png").write_bytes(base64.b64decode(sheet.split(",", 1)[1]))
        # Shrinking the frame count while the preview animates used to crash the preview loop.
        page.wait_for_function("+document.getElementById('scrub').value >= 6", timeout=20_000)
        page.eval_on_selector("#frames", "(e) => { e.value = '3'; e.dispatchEvent(new Event('input')); }")
        page.wait_for_timeout(800)
        n = page.evaluate("window.maskApp.state.frames.length")
        print("frames:", n)
        browser.close()
    server.shutdown()

    if errors:
        print("PAGE ERRORS:", *errors, sep="\n  ")
        sys.exit(1)
    if "Face found" not in status:
        print("FAIL: face not detected")
        sys.exit(1)
    print(f"OK, screenshots in {OUT}")


if __name__ == "__main__":
    main()
