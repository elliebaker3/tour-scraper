"""Assert the bar actually aligns to the broadcast, and says so honestly.

Two regressions are covered.

1. Pinning a stage disabled calibration. loadBundle() only ran the FULL probe
   when it needed to detect the stage, and the full probe is the only thing
   that executes the MAIN-world script -- which is the only place
   __PLAYBACK_STATE__ (and so the broadcast start time) is visible. Pinning
   short-circuited that, auto-calibrate found no start time, and the bar fell
   back to a distance axis that lines up with nothing.

2. A distance-axis bar looks identical to a time-axis one. If it cannot say
   which it is, a climb on screen sitting over a descent on the bar is
   indistinguishable from a calibration that is simply off.

Ground truth is the real stage 14 replay: displayStartTime 2026-07-18T10:30:00Z,
runtime 5h20m26s, race rolling at 11:35:38Z -> 3938s into the recording.
"""
import re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8932
DISPLAY_START_MS = 1784370600000            # 2026-07-18T10:30:00Z

bundle = json.loads((EXT / "data" / "stage-14.json").read_text())
prof = [p for p in bundle["profile"] if p.get("t")]


def rec_sec(iso_t):
    return (datetime.fromisoformat(iso_t).timestamp() * 1000 - DISPLAY_START_MS) / 1000


def gradient_at(km):
    near = [p for p in bundle["profile"] if abs(p["km"] - km) <= 0.5]
    if len(near) < 2:
        return None
    a, b = near[0], near[-1]
    d = b["km"] - a["km"]
    return (b["alt"] - a["alt"]) / (d * 10) if d > 0 else None


# Pick the steepest sustained climb and descent that the GPS actually observed,
# so the expectation is anchored in measured data rather than the estimated head.
scored = []
for p in prof:
    if p.get("est"):
        continue
    g = gradient_at(p["km"])
    if g is not None:
        scored.append((g, p))
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

    base = (f"http://127.0.0.1:{PORT}/_harness.html"
            "?stage=14&video=1&playbackstate=1")
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = br.new_page(viewport={"width": 1400, "height": 800})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: logs.append(m.text[:300]))
        logs = []

        def state():
            return page.evaluate("""() => ({
              axis: (document.querySelector('.tn-axis')||{}).textContent || '',
              clock: document.querySelector('.tn-clock').textContent,
              anchorState: document.querySelector('.tn-anchor-state').textContent,
              playhead: !!document.querySelector('.tn-playhead'),
            })""")

        # --- regression 1: a PINNED stage must still calibrate ---------------
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        # Wait on the calibration actually landing, not on a substring that
        # also appears in the failure text ("not time" contains "time").
        try:
            page.wait_for_function(
                "() => { const e = document.querySelector('.tn-axis');"
                "        return e && !e.textContent.includes('NOT aligned'); }",
                timeout=15000)
        except Exception:
            pass
        s = state()
        print("--- pinned stage 14, broadcast start exposed ---")
        print(f"  axis    {s['axis']}")
        print(f"  status  {s['anchorState']}")
        for l in logs:
            print(f"  log     {l}")
        assert "NOT aligned" not in s["axis"], "FAIL: pinned stage did not calibrate"
        assert s["playhead"], "FAIL: no playhead once calibrated"

        # --- offset is right: race start must land at 3938s ------------------
        expect_start = (datetime.fromisoformat(
            bundle["coverage"]["race_start_utc"]).timestamp() * 1000
            - DISPLAY_START_MS) / 1000
        page.evaluate(f"() => document.querySelector('video').currentTime = {expect_start}")
        page.wait_for_timeout(900)
        s = state()
        print(f"\n  race start expected at rec {expect_start:.0f}s")
        print(f"  clock   {s['clock']}")
        want = bundle["coverage"]["race_start_utc"][11:19]
        assert want in s["clock"], f"FAIL: expected race {want} in clock, got {s['clock']}"

        # --- regression 2: climbs must read as climbs ------------------------
        for label, pt, g in [("steepest climb", climb_p, climb_g),
                             ("steepest descent", descent_p, descent_g)]:
            sec = rec_sec(pt["t"])
            page.evaluate(f"() => document.querySelector('video').currentTime = {sec}")
            page.wait_for_timeout(900)
            c = state()["clock"]
            print(f"\n  {label}: km {pt['km']} alt {pt['alt']}m "
                  f"gradient {g:+.1f}% -> rec {sec:.0f}s")
            print(f"  clock   {c}")
            word = "climbing" if g > 0 else "descending"
            assert word in c, f"FAIL: expected '{word}' at km {pt['km']}, got: {c}"
            # The playhead resolves to the nearest point of the DOWNSAMPLED
            # profile, so a tenth of a km of slack is expected, not an error.
            got_km = float(re.search(r"km (\d+\.\d)", c).group(1))
            assert abs(got_km - pt["km"]) <= 0.5, \
                f"FAIL: playhead at km {got_km}, expected ~{pt['km']}"

        # --- honesty: no broadcast start => must say it is NOT aligned -------
        page.goto(f"http://127.0.0.1:{PORT}/_harness.html?stage=14&video=1")
        page.wait_for_selector(".tn-root .tn-axis", timeout=10000)
        page.wait_for_timeout(3000)
        s = state()
        print("\n--- no broadcast start exposed ---")
        print(f"  axis    {s['axis'].strip()}")
        print(f"  status  {s['anchorState']}")
        assert "NOT aligned" in s["axis"], "FAIL: uncalibrated bar did not say so"
        assert not s["playhead"], "FAIL: meaningless playhead drawn when uncalibrated"

        # --- regression 3: a manual pin must WIN over the auto anchors -------
        # Auto anchors carry no `kind`, so a filter on kind alone left them in
        # place; calFromAnchors reads only the first and last anchor by race
        # time, so the auto pair kept control and the pin changed nothing --
        # while the panel confidently reported the unchanged value back.
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_function(
            "() => { const e = document.querySelector('.tn-axis');"
            "        return e && !e.textContent.includes('NOT aligned'); }",
            timeout=15000)
        PIN_SEC = 4 * 3600 + 40 * 60 + 53          # the real observed finish
        page.evaluate(f"() => document.querySelector('video').currentTime = {PIN_SEC}")
        page.wait_for_timeout(300)
        page.click(".tn-sync-finish")
        page.wait_for_timeout(600)
        status = page.evaluate(
            "() => document.querySelector('.tn-anchor-state').textContent")
        print("\n--- manual pin overrides auto anchors ---")
        print(f"  status  {status}")
        fin = datetime.fromisoformat(bundle["coverage"]["leader_last_seen_utc"])
        want = (fin - timedelta(seconds=PIN_SEC)).strftime("%H:%M:%S")
        print(f"  finish {fin:%H:%M:%S}Z pinned at rec {PIN_SEC}s => rec 0:00 must be {want}Z")
        assert f"rec 0:00 = {want}Z" in status, \
            f"FAIL: pin ignored; expected rec 0:00 = {want}Z, got: {status}"

        print(f"\n  page errors: {errs or 'none'}")
        assert not errs, f"FAIL: page errors {errs}"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
