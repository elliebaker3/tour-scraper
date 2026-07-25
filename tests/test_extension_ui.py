"""Assert the panel draws from a stated default, then sharpens on readings.

The contract:

1. With no readings at all the bar still draws, from the broadcast's own
   shape: about an hour of build-up before the flag, then ~0.92x race time.
   The panel must SAY it is assuming that -- a silent default would be the
   old "the elevation doesn't line up" problem wearing a disguise.

2. Calibration is km-to-go readings and nothing else. A reading is exact
   where it was taken and holds at real time either side of it, because
   between ad breaks the broadcast runs 1:1. Accuracy is therefore local:
   a reading near what you are watching, not more readings in general.

3. The bar spans the full width, imputed where the recording is running but
   no race is, and every readout is in km remaining.

Ground truth is the real stage 14 replay: km 0 at 11:35:38Z, recording second 0
at 10:36:29Z, and the recording advancing at 0.918x race time.
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


# The recording under test runs at 0.918x race time -- the real stage 14 value
# derived from the flag-drop and finish pins. A recording second maps to race
# time by:  race = ZERO + rec_sec / RATE_TRUE.  The extension must recover both
# the origin and this rate from km-to-go readings alone.
RATE_TRUE = 0.9178


def time_at_kmto(km):
    pts = sorted((p for p in bundle["profile"] if p.get("t")), key=lambda p: p["kmto"])
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if a["kmto"] <= km <= b["kmto"]:
            ta, tb = datetime.fromisoformat(a["t"]), datetime.fromisoformat(b["t"])
            span = b["kmto"] - a["kmto"]
            return ta + (tb - ta) * ((km - a["kmto"]) / span if span else 0)
    return None


def rec_for_kmto(km):
    """Recording second at which the broadcast shows this km-to-go."""
    return (time_at_kmto(km) - ZERO).total_seconds() * RATE_TRUE


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

        # Cut the panel off from both live network dependencies. The shared
        # calibration store is fetched from GitHub at load and auto-applied on
        # a match, so whatever anyone has contributed for this stage would
        # decide whether the setup prompt appears -- making the outcome depend
        # on the state of a public file rather than on the code. The collector
        # is blocked for the same reason in reverse: a calibration entered here
        # must never be published from a test run. (Both of these bit for real:
        # harness records reached the live store and then restored themselves
        # back into this suite.) Calibration persistence has its own suite,
        # tests/test_calibration_persist.py, which drives those paths
        # deliberately with stubs.
        page.route("https://raw.githubusercontent.com/**", lambda r: r.abort())
        page.route("**/tour-calibrations*.workers.dev/**", lambda r: r.abort())

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
                hidden: document.querySelector('.tn-root').classList.contains('tn-hidden'),
                setupShown: vis('.tn-setup'),
                barShown: vis('.tn-bar'),
                controlsShown: vis('.tn-controls'),
                markers: bar.querySelectorAll('.tn-marker').length,
                sprints: bar.querySelectorAll('.tn-rm-sprint').length,
                koms: bar.querySelectorAll('.tn-rm-kom').length,
                poiMarks: bar.querySelectorAll('.tn-poi').length,
                filters: [...document.querySelectorAll('.tn-filter')]
                          .map(f => f.textContent.trim()),
                checkedFilters: [...document.querySelectorAll('.tn-filter input:checked')]
                          .length,
                komBadges: [...bar.querySelectorAll('.tn-rm-kom .tn-rm-badge')]
                            .map(e => e.textContent),
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

        # The panel hides itself until the mouse moves (it rides with the
        # player controls). Every interaction below needs it shown, so reveal it
        # after each load. Since the test never fires a mousemove, it then stays.
        def show():
            page.evaluate(
                "() => document.querySelector('.tn-root').classList.remove('tn-hidden')")

        # --- 0: hidden on load, shown on mouse move --------------------------
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(500)
        assert state()["hidden"], "FAIL: panel should start hidden until the mouse moves"
        page.mouse.move(700, 300)
        page.wait_for_timeout(200)
        assert not state()["hidden"], "FAIL: panel should appear on mouse move"
        # ...and hide again after the mouse sits still past the idle timeout.
        page.wait_for_timeout(3600)
        assert state()["hidden"], "FAIL: panel should hide after the mouse is idle"
        print("--- visibility: hidden on load, shown on move, hidden when idle ✓")

        # --- 1: the broadcast's own shape, before any reading ----------------
        # The old contract here was the opposite -- nothing drawn until a
        # reading existed, on the grounds that an uncalibrated profile invites
        # reading false positions off it. That gate is gone: a Peacock
        # recording opens with about an hour of build-up and then runs at
        # ~0.92x, and stating those two assumptions places the stage well
        # enough to draw. A visible, declared default is not the same thing as
        # no clock at all, so the bar now appears immediately and a reading
        # refines it rather than unlocking it.
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(3000)
        show()
        s = state()
        print("--- before any reading ---")
        print(f"  setup shown    {s['setupShown']}")
        print(f"  bar shown      {s['barShown']}")
        print(f"  controls shown {s['controlsShown']}")
        print(f"  markers        {s['markers']}")
        print(f"  buttons        {s['buttons']}")
        assert s["barShown"], "FAIL: bar not drawn from the default model"
        assert s["controlsShown"], "FAIL: controls hidden with the bar drawn"
        # .tn-marker counts RACE EVENTS, which default off; the elevation
        # graphic's own sprint/climb markers are what must be there.
        assert s["sprints"] + s["koms"] > 0, \
            "FAIL: no route markers drawn from the default model"
        # The prompt stays -- it explains how to sharpen the default -- but it
        # no longer REPLACES the bar, which was the old gate's whole effect.
        assert s["setupShown"], "FAIL: no prompt telling the viewer how to refine"

        # The default must SAY what it is assuming -- an unstated default is
        # exactly the silent-wrong-position problem the old gate guarded against.
        assumed = page.evaluate(
            "() => document.querySelector('.tn-anchor-state').textContent")
        print(f"  states default {assumed!r}")
        assert "0.92" in assumed and "build-up" in assumed, \
            f"FAIL: default model not declared to the viewer: {assumed!r}"

        # Only one calibration route is offered.
        for gone in ("Km 0 is NOW", "Anchor here", "Auto-calibrate", "Diagnose", "Align"):
            assert gone not in s["buttons"], f"FAIL: {gone!r} still offered"
        assert "Add reading" in s["buttons"], f"FAIL: no Add reading button: {s['buttons']}"

        # History and Stats are gone; race events default off; sprint/climb and
        # the contenders (POI) markers default on.
        joined = " ".join(s["filters"])
        assert "History" not in joined and "Stats" not in joined, \
            f"FAIL: History/Stats still offered: {s['filters']}"
        assert "Contenders" in joined, f"FAIL: no contenders toggle: {s['filters']}"
        print(f"  filters        {s['filters']}  ({s['checkedFilters']} on)")
        assert s["checkedFilters"] == 3, \
            f"FAIL: expected Sprints+Climbs+Contenders on by default, got {s['checkedFilters']}"

        # A calibration left behind by an OLDER extension version is keyed only
        # by stage, so it could belong to any recording of it -- exactly the
        # mixup that made persistence untrustworthy. It must never be adopted.
        # (Properly keyed calibrations are restored, deliberately; that is
        # tests/test_calibration_persist.py's subject.)
        page.goto(base + "&stalecal=1")
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(3000)     # let the load settle and any restore fire
        show()
        s2 = state()
        stale_state = page.evaluate(
            "() => document.querySelector('.tn-anchor-state').textContent")
        print("\n--- load with a legacy saved calibration present ---")
        print(f"  bar shown {s2['barShown']} · state {stale_state!r}")
        assert "restored" not in stale_state, \
            f"FAIL: a legacy calibration was adopted: {stale_state!r}"

        page.goto(base)               # back to the clean page for the rest
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(1500)
        show()

        # --- 2: one reading calibrates the offset (rate assumed 1.0) ----------
        # Place the video where a 0.918x recording really shows "42 km to go".
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec_for_kmto(42.5)}")
        page.fill(".tn-togo-km", "42")
        page.click(".tn-togo-set")
        page.wait_for_timeout(700)
        s = state()
        print("\n--- one reading (42 km to go) ---")
        print(f"  status  {s['status']}")
        print(f"  diag    {s['diag']}")
        assert s["barShown"], "FAIL: bar still hidden after calibrating"
        assert not s["setupShown"], "FAIL: prompt still shown after a reading"
        # Race-event markers default off, so the bar is uncluttered until asked.
        assert s["markers"] == 0, "FAIL: event markers should default off"
        # A reading refines the GLOBAL rate, which still governs everywhere
        # outside an ad-bracketed interval. With no breaks detected there is
        # no interval to override it, so one reading keeps the 0.92 default
        # rather than switching the whole clock to real time. (The local
        # layer's own behaviour is asserted in section 5b, with markers
        # present.)
        assert "rate 0.92" in s["diag"], \
            f"FAIL: one reading should refine the global 0.92 model, got: {s['diag']}"
        assert "no ad breaks found" in s["diag"], \
            f"FAIL: the panel should say the local layer is dormant: {s['diag']}"

        # Sprint and climb markers are on the profile, from the route data.
        n_sprint = sum(1 for m in bundle["route_markers"] if m["kind"] == "sprint")
        n_kom = sum(1 for m in bundle["route_markers"]
                    if m["kind"] == "kom" and m.get("t"))
        print(f"\n  route markers drawn: {s['sprints']} sprint, {s['koms']} climb "
              f"(bundle has {n_sprint} sprint, {n_kom} timed climb)")
        print(f"  climb badges: {s['komBadges']}")
        assert s["sprints"] == n_sprint, "FAIL: sprint markers not all drawn"
        assert s["koms"] == n_kom, "FAIL: climb markers not all drawn"
        # Categories are labelled (HC / 1-4), not generic.
        assert any(b in ("1", "2", "3") for b in s["komBadges"]), \
            f"FAIL: climb badges not category-labelled: {s['komBadges']}"

        # Persons-of-interest markers: present, but NEVER reveal a name or event
        # (that would spoil what's coming). Assert the marker carries no text and
        # no title/aria anywhere, and that no rider surname from the bundle's POI
        # data appears in the whole panel's rendered text.
        n_special = sum(1 for m in bundle.get("special_markers", [])
                        if m.get("t_utc"))
        print(f"\n  POI markers drawn: {s['poiMarks']} (bundle has {n_special})")
        assert s["poiMarks"] == n_special, "FAIL: POI markers not all drawn"
        # The only text allowed on a contender marker is the star glyph itself;
        # no rider name, no event description, no tooltip.
        leak = page.evaluate("""() => {
          const out = [];
          for (const el of document.querySelectorAll('.tn-poi, .tn-poi *')) {
            const t = (el.textContent || '').replace('\\u2605', '').trim();
            const title = el.getAttribute('title');
            const aria = el.getAttribute('aria-label');
            if (t) out.push('text:' + t);
            if (title) out.push('title:' + title);
            if (aria) out.push('aria:' + aria);
          }
          return out;
        }""")
        assert not leak, f"FAIL: contender marker leaks who/what: {leak}"
        surnames = {p["name"].split()[-1]
                    for j in ("yellow", "green", "white")
                    for p in (bundle.get("persons_of_interest") or {}).get(j, [])}
        panel_text = page.evaluate("() => document.querySelector('.tn-root').innerText")
        shown = sorted(n for n in surnames if n and n in panel_text)
        print(f"  contender surnames visible in the panel: {shown or 'none'}")
        assert not shown, f"FAIL: contender names visible in UI: {shown}"

        # No sprint/climb badge may spill outside the bar (the reported clipping).
        clip = page.evaluate("""() => {
          const bar = document.querySelector('.tn-bar').getBoundingClientRect();
          const out = [];
          for (const b of document.querySelectorAll('.tn-rm-badge')) {
            const r = b.getBoundingClientRect();
            if (r.left < bar.left - 0.5 || r.right > bar.right + 0.5 ||
                r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5) {
              out.push({ txt: b.textContent,
                         dx: Math.round(Math.min(r.left - bar.left, bar.right - r.right)),
                         dy: Math.round(Math.min(r.top - bar.top, bar.bottom - r.bottom)) });
            }
          }
          return out;
        }""")
        print(f"  badges clipped by the bar edge: {clip or 'none'}")
        assert not clip, f"FAIL: route badges cut off: {clip}"

        # The one "Significant event" toggle covers all the race-event kinds.
        assert state()["markers"] == 0, "FAIL: significant events should default off"
        page.click(".tn-filter:has-text('Significant event') input")
        page.wait_for_timeout(400)
        assert state()["markers"] > 0, "FAIL: enabling Significant event drew no markers"
        page.click(".tn-filter:has-text('Significant event') input")   # back off
        page.wait_for_timeout(300)

        # The bar spans the whole recording.
        segs = {k: s[k] for k in ("obs", "est", "imp") if s[k]}
        lo = min(v["min"] for v in segs.values())
        hi = max(v["max"] for v in segs.values())
        assert lo <= 1 and hi >= s["width"] - 1, "FAIL: bar does not span the recording"
        assert s["imp"], "FAIL: nothing imputed outside the race"

        # --- 3: ONE reading already lands close, thanks to the 0.92 default ---
        # The global layer is what makes a single reading usable across the
        # whole stage: rate 1.0 would drift ~13 km by the finish on a 0.918x
        # recording, where starting from 0.92 keeps it within a kilometre
        # everywhere. (The local layer sharpens one interval on top of this;
        # it does not replace it -- section 5b.)
        for kmto in (41.0, 35.0, 5.5):
            page.evaluate(f"() => document.querySelector('video').currentTime = {rec_for_kmto(kmto)}")
            page.wait_for_timeout(600)
            m = re.search(r"([\d.]+) km to go", state()["clock"])
            off = abs(float(m.group(1)) - kmto)
            print(f"  truth {kmto} km to go -> bar says {m.group(1)} ({off:.1f} km off)")
            assert off <= 1.5, \
                f"FAIL: one reading at the 0.92 default should stay close, got {off:.1f} km"

        # --- 4: a second reading brackets the gap and removes that drift ------
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec_for_kmto(150.5)}")
        page.fill(".tn-togo-km2", "150")
        page.click(".tn-togo-set2")
        page.wait_for_timeout(700)
        s = state()
        print(f"\n--- two readings (42 and 150 km to go) ---")
        print(f"  status  {s['status']}")
        print(f"  diag    {s['diag']}")
        rate_m = re.search(r"rate (\d\.\d+)", s["diag"])
        assert rate_m, f"FAIL: no rate in diag: {s['diag']}"
        got_rate = float(rate_m.group(1))
        # Between two readings the map is a straight line, so the slope it
        # reports IS the recording's true average over that span -- ad breaks
        # and all. Recovering 0.918x here is what proves the span is measured
        # rather than assumed.
        print(f"  average across the two readings {got_rate} vs true {RATE_TRUE}")
        assert abs(got_rate - RATE_TRUE) <= 0.01, \
            f"FAIL: span average not recovered: {got_rate} vs {RATE_TRUE}"

        # With the rate fitted, the global layer is accurate across the whole
        # stage -- including past the outermost reading, which is exactly what
        # the unbounded-real-time experiment got wrong.
        print("\n--- two readings: km-to-go accurate across the stage ---")
        for shown in (130, 90, 50, 20, 8):
            page.evaluate(f"() => document.querySelector('video').currentTime = {rec_for_kmto(shown + 0.5)}")
            page.wait_for_timeout(500)
            m = re.search(r"([\d.]+) km to go", state()["clock"])
            off = abs(float(m.group(1)) - (shown + 0.5))
            print(f"  screen {shown} km to go -> bar says {m.group(1)} ({off:.1f} km off)")
            assert off <= 1.5, f"FAIL: {off:.1f} km gap at {shown} km to go after rate fit"

        # --- 5b: the local layer, inside an ad-bracketed interval ------------
        # The two layers are meant to coexist: a universal rate everywhere,
        # overridden by real time (1x) only inside the ad-break interval a
        # reading was taken in. The decisive measurement is the SLOPE: over
        # 600 recording seconds inside that interval the race clock must
        # advance 600s, where the global 0.92x model would advance ~652s.
        page.goto(base + "&adbreaks=3000,6000,9000,12000")
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(2500)
        show()
        found = re.search(r"(\d+) ad breaks", state()["diag"])
        assert found and int(found.group(1)) == 4, \
            f"FAIL: ad markers not detected from the scrub bar: {state()['diag']}"

        def kmto_now():
            m = re.search(r"([\d.]+) km to go", state()["clock"])
            return float(m.group(1)) if m else None

        def race_seconds_between(a_km, b_km):
            return abs((time_at_kmto(b_km) - time_at_kmto(a_km)).total_seconds())

        # Anchor a reading in the middle of the interval [3000, 6000].
        page.evaluate("() => document.querySelector('video').currentTime = 4500")
        page.wait_for_timeout(600)
        here = kmto_now()
        page.fill(".tn-togo-km2", str(int(here)))
        page.click(".tn-togo-set2")
        page.wait_for_timeout(700)

        # Re-read the baseline AFTER the reading: entering a whole number
        # applies the midpoint convention ("42" means 42.0-43.0), so the
        # anchored position differs from the pre-reading estimate by up to a
        # kilometre. Measuring the slope against the stale value would charge
        # that offset to the slope.
        page.evaluate("() => document.querySelector('video').currentTime = 4500")
        page.wait_for_timeout(600)
        base_km = kmto_now()

        # Step forward 600s, staying inside the same interval.
        page.evaluate("() => document.querySelector('video').currentTime = 5100")
        page.wait_for_timeout(600)
        inside = race_seconds_between(kmto_now(), base_km)
        print(f"\n--- local layer, inside the bracket [3000s, 6000s] ---")
        print(f"  600 recording seconds advanced the race clock {inside:.0f}s "
              f"(1x would be 600, the 0.92x global would be ~652)")
        assert abs(inside - 600) < 45, \
            f"FAIL: inside the bracket should run 1x, got {inside:.0f}s per 600s"

        # Now step well past the interval's far edge; the global rate resumes,
        # so the same 600 recording seconds must cover MORE race time again.
        page.evaluate("() => document.querySelector('video').currentTime = 9500")
        page.wait_for_timeout(600)
        far_a = kmto_now()
        page.evaluate("() => document.querySelector('video').currentTime = 10100")
        page.wait_for_timeout(600)
        outside = race_seconds_between(kmto_now(), far_a)
        print(f"  outside it, the same 600s covered {outside:.0f}s of race time")
        assert outside > inside + 20, \
            ("FAIL: outside the bracket the global rate should resume, "
             f"but {outside:.0f}s is not meaningfully more than {inside:.0f}s")

        page.goto(base)            # back to the plain page for the rest
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(2000)
        show()
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec_for_kmto(42.5)}")
        page.fill(".tn-togo-km2", "42")
        page.click(".tn-togo-set2")
        page.wait_for_timeout(700)

        # --- 6: reset returns to the prompt ----------------------------------
        page.click(".tn-anchor-clear")
        page.wait_for_timeout(700)
        s = state()
        print(f"\n  after reset: setup={s['setupShown']} bar={s['barShown']}")
        # Reset drops the readings, not the clock: the stated default is still
        # a clock, so the bar keeps drawing and the prompt comes back with it.
        assert s["setupShown"], "FAIL: reset did not bring the prompt back"
        assert s["barShown"], "FAIL: reset should fall back to the default model, not blank"

        print(f"\n  page errors: {errs or 'none'}")
        assert not errs, f"FAIL: page errors {errs}"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
