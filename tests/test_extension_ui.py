"""Assert the panel shows nothing until it is calibrated, then everything.

The contract:

1. Before calibration the panel is the setup prompt and nothing else -- no
   bar, no markers, no filters. A profile with no clock invites reading
   positions off it that are not real, which is how every "the elevation
   doesn't line up" report began.

2. There is exactly ONE way to calibrate: type the km-to-go the broadcast is
   showing at the current moment, and press Calibrate.

3. Once calibrated the bar appears, spans the full width (imputed where the
   recording is running but no race is), and every readout is in km remaining.

Ground truth is the real stage 14 replay: runtime 5h20m26s, km 0 at 11:35:38Z
observed at recording second 3549, so recording second 0 is 10:36:29Z.
"""
import json, re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8931
KM0_REC = 59 * 60 + 9

bundle = json.loads((EXT / "data" / "stage-14.json").read_text())
start_utc = datetime.fromisoformat(bundle["coverage"]["race_start_utc"])
ZERO = start_utc - timedelta(seconds=KM0_REC)


def time_at_kmto(km):
    pts = sorted((p for p in bundle["profile"] if p.get("t")), key=lambda p: p["kmto"])
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if a["kmto"] <= km <= b["kmto"]:
            ta, tb = datetime.fromisoformat(a["t"]), datetime.fromisoformat(b["t"])
            span = b["kmto"] - a["kmto"]
            return ta + (tb - ta) * ((km - a["kmto"]) / span if span else 0)
    return None


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

    base = f"http://127.0.0.1:{PORT}/_harness.html?stage=14&video=1&playbackstate=1"
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = br.new_page(viewport={"width": 1400, "height": 800})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        def state():
            return page.evaluate("""() => {
              const vis = (sel) => {
                const e = document.querySelector(sel);
                return !!e && getComputedStyle(e).display !== 'none';
              };
              const bar = document.querySelector('.tn-bar');
              const seg = (sel) => {
                const d = [...bar.querySelectorAll(sel)]
                  .map(p => p.getAttribute('d') || '').join(' ');
                if (!d.trim()) return null;
                const xs = [...d.matchAll(/(-?\\d+\\.?\\d*)\\s(-?\\d+\\.?\\d*)/g)]
                  .map(m => parseFloat(m[1]));
                return { min: Math.min(...xs), max: Math.max(...xs) };
              };
              return {
                setupShown: vis('.tn-setup'),
                barShown: vis('.tn-bar'),
                controlsShown: vis('.tn-controls'),
                markers: bar.querySelectorAll('.tn-marker').length,
                clock: document.querySelector('.tn-clock').textContent,
                status: document.querySelector('.tn-anchor-state').textContent,
                diag: document.querySelector('.tn-diag').textContent,
                width: bar.clientWidth,
                obs: seg('.tn-profile:not(.tn-profile-est):not(.tn-profile-imp)'),
                est: seg('.tn-profile-est'),
                imp: seg('.tn-profile-imp'),
                buttons: [...document.querySelectorAll('.tn-root button')]
                          .map(b => b.textContent.trim()),
              };
            }""")

        # --- 1: nothing before calibration -----------------------------------
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(3000)
        s = state()
        print("--- before calibration ---")
        print(f"  setup shown    {s['setupShown']}")
        print(f"  bar shown      {s['barShown']}")
        print(f"  controls shown {s['controlsShown']}")
        print(f"  markers        {s['markers']}")
        print(f"  buttons        {s['buttons']}")
        assert s["setupShown"], "FAIL: setup prompt not shown"
        assert not s["barShown"], "FAIL: bar visible before calibration"
        assert not s["controlsShown"], "FAIL: controls visible before calibration"
        assert s["markers"] == 0, "FAIL: markers drawn before calibration"

        # Only one calibration route is offered.
        for gone in ("Km 0 is NOW", "Anchor here", "Auto-calibrate", "Diagnose", "Align"):
            assert gone not in s["buttons"], f"FAIL: {gone!r} still offered"
        assert "Calibrate" in s["buttons"], f"FAIL: no Calibrate button: {s['buttons']}"

        # A saved calibration must NOT be restored: it is the flash-then-revert
        # bug. Even a current-shape entry is ignored and the prompt stays.
        page.goto(base + "&stalecal=1")
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(3000)     # let the load settle and any restore fire
        s2 = state()
        print("\n--- load with a saved calibration present ---")
        print(f"  setup shown {s2['setupShown']} · bar shown {s2['barShown']}")
        assert s2["setupShown"] and not s2["barShown"], \
            "FAIL: a saved calibration was restored instead of prompting"

        page.goto(base)               # back to the clean page for the rest
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(1500)

        # --- 2: one reading calibrates ---------------------------------------
        t = time_at_kmto(42.5)              # "42" on screen means [42, 43)
        rec = (t - ZERO).total_seconds()
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec}")
        page.fill(".tn-togo-km", "42")
        page.click(".tn-togo-set")
        page.wait_for_timeout(700)
        s = state()
        print("\n--- after typing 42 km to go ---")
        print(f"  status  {s['status']}")
        print(f"  diag    {s['diag']}")
        print(f"  clock   {s['clock']}")
        assert s["barShown"], "FAIL: bar still hidden after calibrating"
        assert not s["setupShown"], "FAIL: setup prompt still shown after calibrating"
        assert s["markers"] > 0, "FAIL: no guideposts after calibrating"
        got = re.search(r"rec 0:00 = (\d\d:\d\d:\d\d)Z", s["diag"])
        assert got, f"FAIL: no origin in diag: {s['diag']}"
        delta = abs((datetime.strptime(got.group(1), "%H:%M:%S")
                     - datetime.strptime(ZERO.strftime("%H:%M:%S"), "%H:%M:%S")).total_seconds())
        print(f"  origin  {got.group(1)}Z vs expected {ZERO:%H:%M:%S}Z -> {delta:.0f}s off")
        assert delta <= 20, f"FAIL: origin off by {delta:.0f}s"

        # --- 3: the bar spans the whole recording ----------------------------
        segs = {k: s[k] for k in ("obs", "est", "imp") if s[k]}
        lo = min(v["min"] for v in segs.values())
        hi = max(v["max"] for v in segs.values())
        print("\n--- coverage ---")
        for k, v in segs.items():
            print(f"  {k:4} x {v['min']:7.1f} -> {v['max']:7.1f}")
        print(f"  total x {lo:.1f} -> {hi:.1f} of {s['width']}px")
        assert lo <= 1 and hi >= s["width"] - 1, "FAIL: bar does not span the recording"
        assert s["imp"], "FAIL: nothing imputed outside the race"

        # --- 4: readouts count down to the line ------------------------------
        for pt, want in [(p, "climbing") for p in [max(
            (q for q in bundle["profile"] if q.get("t") and not q.get("est")),
            key=lambda q: q["alt"])]]:
            sec = (datetime.fromisoformat(pt["t"]) - ZERO).total_seconds()
            page.evaluate(f"() => document.querySelector('video').currentTime = {sec}")
            page.wait_for_timeout(700)
            c = state()["clock"]
            print(f"\n  summit km {pt['km']} ({pt['alt']}m) -> {c}")
            m = re.search(r"([\d.]+) km to go", c)
            assert m, f"FAIL: clock not in km-to-go: {c}"
            assert abs(float(m.group(1)) - pt["kmto"]) <= 1.0, \
                f"FAIL: expected ~{pt['kmto']} km to go, got {m.group(1)}"

        # --- 5: a second reading refines via the median ----------------------
        t2 = time_at_kmto(95.5)
        rec2 = (t2 - ZERO).total_seconds()
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec2}")
        page.fill(".tn-togo-km2", "95")
        page.click(".tn-togo-set2")
        page.wait_for_timeout(700)
        s = state()
        print(f"\n  second reading -> {s['status']}")
        assert "2 readings" in s["status"], f"FAIL: readings not combined: {s['status']}"

        # --- 6: reset returns to the prompt ----------------------------------
        page.click(".tn-anchor-clear")
        page.wait_for_timeout(700)
        s = state()
        print(f"\n  after reset: setup={s['setupShown']} bar={s['barShown']}")
        assert s["setupShown"] and not s["barShown"], "FAIL: reset did not return to setup"

        print(f"\n  page errors: {errs or 'none'}")
        assert not errs, f"FAIL: page errors {errs}"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
