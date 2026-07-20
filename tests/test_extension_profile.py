"""Assert the elevation profile renders without a video and without calibration.

The regression this guards against is silent: profilePath() used to position
every point through utcToVideo(), so an uncalibrated bar drew an empty path and
looked merely 'not ready yet' rather than broken.
"""
import shutil, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8931

# The harness must be same-origin with data/*.json for fetch to reach it, so it
# is copied in for the run and removed afterwards -- it is a test fixture and
# has no business shipping inside the extension.
harness = EXT / "_harness.html"
shutil.copy(ROOT / "tests" / "extension_harness.html", harness)

srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", str(EXT)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/data/index.json", timeout=1)
            break
        except Exception:
            time.sleep(0.1)

    with sync_playwright() as p:
        br = p.chromium.launch()
        page = br.new_page(viewport={"width": 1400, "height": 800})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        def probe(url, label):
            page.goto(url)
            # state=attached: an empty <path d=""> counts as invisible, and the
            # est path is legitimately empty on stages with full GPS coverage.
            page.wait_for_selector(".tn-root .tn-bar svg path.tn-profile",
                                   state="attached", timeout=8000)
            page.wait_for_timeout(1200)
            return page.evaluate("""() => {
              const bar = document.querySelector('.tn-bar');
              const w = bar.clientWidth;
              const read = (sel) => {
                const p = bar.querySelector(sel);
                const d = p ? p.getAttribute('d') : '';
                if (!d) return null;
                const xs = [...d.matchAll(/(-?\\d+\\.?\\d*)\\s(-?\\d+\\.?\\d*)/g)]
                  .map(m => parseFloat(m[1]));
                return { n: xs.length, min: Math.min(...xs), max: Math.max(...xs) };
              };
              return {
                width: w,
                obs: read('path.tn-profile:not(.tn-profile-est)'),
                est: read('path.tn-profile-est'),
                markers: bar.querySelectorAll('.tn-marker').length,
                ticks: bar.querySelectorAll('.tn-tick').length,
                axis: (bar.querySelector('.tn-axis')||{}).textContent || null,
                clock: document.querySelector('.tn-clock').textContent,
                stage: document.querySelector('.tn-stage').textContent.slice(0, 60),
              };
            }""")

        base = f"http://127.0.0.1:{PORT}/_harness.html"
        for label, url in [("no video, no calibration", base),
                           ("video present, uncalibrated", base + "?video=1"),
                           ("stage 14 (has estimated head)", base + "?stage=14")]:
            r = probe(url, label)
            span_lo = min(x for x in [r["obs"]["min"] if r["obs"] else 9e9,
                                      r["est"]["min"] if r["est"] else 9e9])
            span_hi = max(x for x in [r["obs"]["max"] if r["obs"] else -9e9,
                                      r["est"]["max"] if r["est"] else -9e9])
            print(f"\n--- {label} ---")
            print(f"  bar width      {r['width']}px")
            print(f"  observed path  {r['obs']}")
            print(f"  estimated path {r['est']}")
            print(f"  profile spans  x={span_lo:.1f} -> {span_hi:.1f} "
                  f"({span_lo/r['width']*100:.1f}% -> {span_hi/r['width']*100:.1f}% of bar)")
            print(f"  markers {r['markers']} · ticks {r['ticks']}")
            print(f"  axis  {r['axis']}")
            print(f"  clock {r['clock']}")
            print(f"  stage {r['stage']}")
            assert (r["obs"] or r["est"]), "FAIL: profile did not draw"
            assert span_hi > r["width"] * 0.97, "FAIL: profile does not reach the right edge"
            assert span_lo < r["width"] * 0.02, "FAIL: profile does not start at the left edge"
            assert r["markers"] > 0, "FAIL: no guideposts placed"

        # Hover readout
        page.mouse.move(300, 0)
        box = page.evaluate("""() => {
          const b = document.querySelector('.tn-bar').getBoundingClientRect();
          return {x: b.x, y: b.y, w: b.width, h: b.height};
        }""")
        page.mouse.move(box["x"] + box["w"] * 0.5, box["y"] + box["h"] / 2)
        page.wait_for_timeout(300)
        hov = page.evaluate("""() => {
          const h = document.querySelector('.tn-hover');
          return h ? {text: h.textContent, shown: getComputedStyle(h).display} : null;
        }""")
        print(f"\n  hover at 50%   {hov}")
        assert hov and hov["shown"] != "none", "FAIL: hover readout not shown"
        assert "km to go" in hov["text"], \
            f"FAIL: hover should report distance remaining, got: {hov['text']}"

        # Ticks must count DOWN toward the line, left to right.
        ticks = page.evaluate(
            "() => [...document.querySelectorAll('.tn-tick span')].map(e => e.textContent)")
        print(f"  ticks          {ticks}")
        nums = [float(t.split("km")[0]) for t in ticks]
        assert all("to go" in t for t in ticks), f"FAIL: ticks not in km-to-go: {ticks}"
        assert nums == sorted(nums, reverse=True), \
            f"FAIL: km-to-go ticks should decrease left to right: {nums}"

        # Collapsed must keep the profile on screen.
        page.click(".tn-collapse")
        page.wait_for_timeout(900)          # let the 500ms redraw tick land
        col = page.evaluate("""() => {
          const b = document.querySelector('.tn-bar');
          const c = document.querySelector('.tn-controls');
          const d = b.querySelector('path.tn-profile:not(.tn-profile-est)')
                     .getAttribute('d') || '';
          const ys = [...d.matchAll(/(-?\\d+\\.?\\d*)\\s(-?\\d+\\.?\\d*)/g)]
                       .map(m => parseFloat(m[2]));
          return {barH: b.getBoundingClientRect().height,
                  barVisible: getComputedStyle(b).display !== 'none',
                  controlsVisible: getComputedStyle(c).display !== 'none',
                  pathLen: d.length, maxY: Math.max(...ys)};
        }""")
        print(f"  collapsed      {col}")
        assert col["barVisible"] and col["pathLen"] > 100, "FAIL: profile hidden when collapsed"
        # The drawing must rescale to the slim bar, not overflow it.
        assert col["maxY"] <= col["barH"] + 0.5, \
            f"FAIL: profile drawn to {col['maxY']}px in a {col['barH']}px bar"
        assert not col["controlsVisible"], "FAIL: controls still shown when collapsed"

        print(f"\n  page errors: {errs or 'none'}")
        assert not errs, "FAIL: page errors"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
