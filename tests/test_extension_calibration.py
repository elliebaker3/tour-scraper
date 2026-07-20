"""Assert the bar calibrates from km 0 and imputes elevation everywhere else.

The contract, after a long run of alignment bugs:

1. Nothing calibrates itself on load. The broadcast's own start metadata was
   27 minutes adrift of the recording's real origin on stage 14, and a
   confidently wrong clock is worse than an absent one -- it puts every summit
   on a descent with nothing on screen to say so. The bar asks for km 0.

2. km 0 alone is a complete calibration. The broadcast has no inserted breaks,
   so rate is 1.0 by construction. Fitting a rate from two pins turned a few
   seconds of click imprecision into a slope across four hours (it produced
   0.918x -- "20 minutes of racing missing" -- from a single mis-click).

3. The trace spans the whole bar. The recording runs before km 0 and past the
   finish, where no elevation exists because nobody is racing; those stretches
   are imputed and drawn faintly rather than left blank.

Ground truth is the real stage 14 replay: runtime 5h20m26s, km 0 at 11:35:38Z,
finish at 15:37:46Z.
"""
import json, re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8932
KM0_REC = 59 * 60 + 9          # observed recording time at the flag drop

bundle = json.loads((EXT / "data" / "stage-14.json").read_text())
start_utc = datetime.fromisoformat(bundle["coverage"]["race_start_utc"])
fin_utc = datetime.fromisoformat(bundle["coverage"]["leader_last_seen_utc"])


def gradient_at(km):
    near = [p for p in bundle["profile"] if abs(p["km"] - km) <= 0.5]
    if len(near) < 2:
        return None
    a, b = near[0], near[-1]
    d = b["km"] - a["km"]
    return (b["alt"] - a["alt"]) / (d * 10) if d > 0 else None


scored = [(gradient_at(p["km"]), p) for p in bundle["profile"]
          if p.get("t") and not p.get("est") and gradient_at(p["km"]) is not None]
scored.sort(key=lambda x: x[0])
descent_g, descent_p = scored[0]
climb_g, climb_p = scored[-1]

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
                axis: (bar.querySelector('.tn-axis')||{}).textContent || '',
                clock: document.querySelector('.tn-clock').textContent,
                status: document.querySelector('.tn-anchor-state').textContent,
                diag: document.querySelector('.tn-diag').textContent,
                width: bar.clientWidth,
                obs: seg('.tn-profile:not(.tn-profile-est):not(.tn-profile-imp)'),
                est: seg('.tn-profile-est'),
                imp: seg('.tn-profile-imp'),
              };
            }""")

        # --- 1: no self-calibration on load; it asks for km 0 ----------------
        page.goto(base)
        page.wait_for_selector(".tn-root .tn-axis", timeout=10000)
        page.wait_for_timeout(3000)
        s = state()
        print("--- on load ---")
        print(f"  axis    {' '.join(s['axis'].split())}")
        assert "Calibrate" in s["axis"], f"FAIL: expected a calibrate prompt, got: {s['axis']}"

        # --- 2: km 0 typed into the box calibrates ---------------------------
        page.fill(".tn-km0-time", "0:59:09")
        page.click(".tn-km0-set")
        page.wait_for_timeout(700)
        s = state()
        print("\n--- after typing km 0 = 0:59:09 ---")
        print(f"  status  {s['status']}")
        print(f"  diag    {s['diag']}")
        want_zero = (start_utc - timedelta(seconds=KM0_REC)).strftime("%H:%M:%S")
        assert "rate 1.000" in s["status"], f"FAIL: rate not locked: {s['status']}"
        assert f"rec 0:00 = {want_zero}Z" in s["diag"], \
            f"FAIL: expected rec 0:00 = {want_zero}Z, got: {s['diag']}"

        # The finish must land where km 0 plus elapsed race time puts it.
        want_fin = KM0_REC + (fin_utc - start_utc).total_seconds()
        page.evaluate(f"() => document.querySelector('video').currentTime = {want_fin}")
        page.wait_for_timeout(700)
        c = state()["clock"]
        print(f"\n  finish predicted at rec {want_fin:.0f}s -> {c}")
        assert fin_utc.strftime("%H:%M:%S") in c, \
            f"FAIL: finish not at predicted time, got: {c}"

        # --- 3: climbs read as climbs ----------------------------------------
        for label, pt, g in [("steepest climb", climb_p, climb_g),
                             ("steepest descent", descent_p, descent_g)]:
            sec = KM0_REC + (datetime.fromisoformat(pt["t"]) - start_utc).total_seconds()
            page.evaluate(f"() => document.querySelector('video').currentTime = {sec}")
            page.wait_for_timeout(700)
            c = state()["clock"]
            print(f"\n  {label}: km {pt['km']} ({g:+.1f}%) -> rec {sec:.0f}s")
            print(f"  clock   {c}")
            word = "climbing" if g > 0 else "descending"
            assert word in c, f"FAIL: expected '{word}' at km {pt['km']}, got: {c}"
            # Distance is reported as remaining to the line, not travelled.
            want_togo = pt["kmto"]
            m = re.search(r"([\d.]+) km to go", c)
            assert m, f"FAIL: no 'km to go' readout, got: {c}"
            assert abs(float(m.group(1)) - want_togo) <= 1.0, \
                f"FAIL: expected ~{want_togo} km to go, got {m.group(1)}"

        # --- 4: the trace spans the entire bar, imputed where it must --------
        s = state()
        segs = {k: s[k] for k in ("obs", "est", "imp") if s[k]}
        lo = min(v["min"] for v in segs.values())
        hi = max(v["max"] for v in segs.values())
        print("\n--- coverage of the bar ---")
        for k, v in segs.items():
            print(f"  {k:4} x {v['min']:7.1f} -> {v['max']:7.1f}")
        print(f"  total x {lo:.1f} -> {hi:.1f} of {s['width']}px")
        assert lo <= 1, f"FAIL: trace starts at {lo}px, not the left edge"
        assert hi >= s["width"] - 1, f"FAIL: trace ends at {hi}px of {s['width']}"
        assert s["imp"], "FAIL: no imputed stretch drawn (pre-race/post-finish)"
        assert s["imp"]["min"] <= 1, "FAIL: pre-race build-up not imputed"
        assert s["imp"]["max"] >= s["width"] - 1, "FAIL: post-finish tail not imputed"

        # --- 5: a calibration saved by an older version must be discarded ----
        # Otherwise reloading the extension restores the broken clock, no
        # prompt appears, and it looks like nothing changed.
        page.goto(base + "&stalecal=1")
        page.wait_for_selector(".tn-root .tn-axis", timeout=10000)
        page.wait_for_timeout(2500)
        s = state()
        print("\n--- reload with a stale saved calibration ---")
        print(f"  axis    {' '.join(s['axis'].split())}")
        print(f"  diag    {s['diag']}")
        assert "Calibrate" in s["axis"], \
            f"FAIL: stale calibration was restored instead of prompting: {s['axis']}"
        assert "0.918" not in s["diag"], f"FAIL: stale rate survived: {s['diag']}"

        # --- 6: calibrate from the broadcast's own "km to go" graphic --------
        # The graphic counts in whole kilometres, so "42" means [42, 43) and
        # the midpoint 42.5 is the best reading of it. Placing the video at the
        # moment the leader really was at 42.5 to go must recover the same
        # origin the km-0 pin gave.
        def time_at_kmto(km):
            pts = sorted((p for p in bundle["profile"] if p.get("t")),
                         key=lambda p: p["kmto"])
            for i in range(1, len(pts)):
                a, b = pts[i - 1], pts[i]
                if a["kmto"] <= km <= b["kmto"]:
                    ta = datetime.fromisoformat(a["t"])
                    tb = datetime.fromisoformat(b["t"])
                    span = b["kmto"] - a["kmto"]
                    f = (km - a["kmto"]) / span if span else 0
                    return ta + (tb - ta) * f
            return None

        zero = start_utc - timedelta(seconds=KM0_REC)
        page.goto(base)
        page.wait_for_selector(".tn-root .tn-axis", timeout=10000)
        page.wait_for_timeout(2500)

        print("\n--- calibrate from \"km to go\" ---")
        for shown, expect_exact in [(42, 42.5), (95, 95.5)]:
            t = time_at_kmto(expect_exact)
            rec = (t - zero).total_seconds()
            page.evaluate(f"() => document.querySelector('video').currentTime = {rec}")
            page.fill(".tn-togo-at", "")
            page.fill(".tn-togo-km", str(shown))
            page.click(".tn-togo-set")
            page.wait_for_timeout(600)
            st = state()
            print(f"  typed {shown} at rec {rec:.0f}s ({t:%H:%M:%S}Z)")
            print(f"    {st['status']}")
            got = re.search(r"rec 0:00 = (\d\d:\d\d:\d\d)Z", st["diag"])
            assert got, f"FAIL: no origin in diag: {st['diag']}"
            got_t = datetime.strptime(got.group(1), "%H:%M:%S").time()
            delta = abs((datetime.combine(zero.date(), got_t)
                         - zero.replace(tzinfo=None)).total_seconds())
            print(f"    origin {got.group(1)}Z vs expected {zero:%H:%M:%S}Z "
                  f"-> {delta:.0f}s off")
            assert delta <= 20, f"FAIL: origin off by {delta:.0f}s"

        # Two pins now: the median is used, and it must still agree.
        assert "2 pins" in state()["status"], \
            f"FAIL: expected 2 pins to combine, got: {state()['status']}"

        # A time can also be typed rather than scrubbed to.
        t = time_at_kmto(42.5)
        rec = (t - zero).total_seconds()
        hhmmss = f"{int(rec//3600)}:{int(rec%3600//60):02d}:{int(rec%60):02d}"
        page.click(".tn-anchor-clear")
        page.wait_for_timeout(300)
        page.fill(".tn-togo-at", hhmmss)
        page.fill(".tn-togo-km", "42")
        page.click(".tn-togo-set")
        page.wait_for_timeout(600)
        st = state()
        print(f"\n  typed time {hhmmss} + 42 km to go")
        print(f"    {st['status']}")
        assert f"rec {hhmmss}" in st["status"] or "rec 0:00" in st["diag"], \
            f"FAIL: typed time ignored: {st['status']}"
        got = re.search(r"rec 0:00 = (\d\d:\d\d:\d\d)Z", st["diag"])
        got_t = datetime.strptime(got.group(1), "%H:%M:%S").time()
        delta = abs((datetime.combine(zero.date(), got_t)
                     - zero.replace(tzinfo=None)).total_seconds())
        assert delta <= 20, f"FAIL: typed-time origin off by {delta:.0f}s"

        print(f"\n  page errors: {errs or 'none'}")
        assert not errs, f"FAIL: page errors {errs}"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
