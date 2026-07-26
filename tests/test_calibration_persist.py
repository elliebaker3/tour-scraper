"""Assert a calibration survives a reload -- and only onto the SAME recording.

The contract:

1. Entering a km-to-go reading stores it against (stage, site, recording
   duration). Reload, and the bar comes back calibrated on its own: no
   prompt, same rate, and the panel says where the numbers came from.

2. The fingerprint is what makes that safe. Pose as a different cut of the
   same stage (different duration) and the saved calibration must NOT be
   applied -- that recording gets the setup prompt and its own slot. This is
   the failure the earlier "never persist" rule was working around; keying
   fixes it properly.

3. Reset clears only this recording's slot, and the other recording's saved
   calibration is still there afterwards.

4. Lite (profile-only) stages calibrate too. They have no race clock, so
   readings map km-to-go straight onto recording seconds: one reading is
   recorded but leaves the playhead off, two give a playhead and seeking.

Ground truth is the same stage 14 replay the UI test uses: km 0 at
11:35:38Z, recording second 0 at 10:36:29Z, advancing at 0.918x race time.
"""
import json, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8934
KM0_REC = 59 * 60 + 9
RATE_TRUE = 0.9178

bundle = json.loads((EXT / "data" / "stage-14.json").read_text())
ZERO = (datetime.fromisoformat(bundle["coverage"]["race_start_utc"])
        - timedelta(seconds=KM0_REC))


def time_at_kmto(km):
    pts = sorted((p for p in bundle["profile"] if p.get("t")), key=lambda p: p["kmto"])
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if a["kmto"] <= km <= b["kmto"]:
            ta, tb = datetime.fromisoformat(a["t"]), datetime.fromisoformat(b["t"])
            span = b["kmto"] - a["kmto"]
            f = (km - a["kmto"]) / span if span else 0
            return ta + (tb - ta) * f
    raise SystemExit(f"no profile coverage at {km} km to go")


def rec_for_kmto(km):
    return (time_at_kmto(km) - ZERO).total_seconds() * RATE_TRUE


failures = []


def check(label, ok, detail=""):
    print(f"  {'OK  ' if ok else 'FAIL'} {label}{' — ' + detail if detail else ''}")
    if not ok:
        failures.append(label)


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

        # The shared store is fetched from GitHub and auto-applied on a match,
        # so leaving it live would let whatever is published for this stage
        # decide whether a recording looks calibrated -- and it did exactly
        # that: harness submissions reached the real store and then restored
        # themselves back into this suite, surviving even a reset. Blocked
        # here so every assertion below is about the local tier only; the
        # shared tier is exercised with a stub in section 5.
        page.route("https://raw.githubusercontent.com/**", lambda r: r.abort())

        def state():
            return page.evaluate("""() => {
              const vis = (sel) => {
                const e = document.querySelector(sel);
                return !!e && getComputedStyle(e).display !== 'none';
              };
              return {
                setup: vis('.tn-setup'),
                bar: vis('.tn-bar'),
                anchorState: document.querySelector('.tn-diag')?.textContent || '',
                diag: document.querySelector('.tn-diag')?.textContent || '',
                clock: document.querySelector('.tn-clock')?.textContent || '',
                playhead: !!document.querySelector('.tn-playhead'),
              };
            }""")

        def calibrate(km, at_sec, field=".tn-togo-km", button=".tn-togo-set"):
            show()
            page.evaluate(f"document.querySelector('video').currentTime = {at_sec}")
            page.fill(field, str(km))
            page.click(button)
            page.wait_for_timeout(400)

        # The panel rides with the player controls and hides itself when the
        # mouse is idle; nothing here can be clicked while it is hidden.
        def show():
            page.evaluate(
                "() => document.querySelector('.tn-root').classList.remove('tn-hidden')")

        # playbackstate carries stage 14's airing date, and detection rightly
        # beats a pin -- so any other stage has to be loaded without it, the
        # way a recording whose airing date can't be read behaves.
        def load(stage=14, dur=None, wait=1800, playbackstate=None):
            if playbackstate is None:
                playbackstate = (stage == 14)
            url = (f"http://127.0.0.1:{PORT}/_harness.html?stage={stage}&video=1"
                   + ("&playbackstate=1" if playbackstate else ""))
            if dur is not None:
                url += f"&dur={dur}"
            page.goto(url)
            page.wait_for_selector(".tn-root", timeout=15000)
            page.wait_for_timeout(wait)
            show()

        # --- 1. calibrate, then reload and expect it back -------------------
        print("\n--- full stage: calibrate two readings, then reload ---")
        load()
        calibrate(150, rec_for_kmto(150.5))
        calibrate(20, rec_for_kmto(20.5), ".tn-togo-km2", ".tn-togo-set2")
        before = state()
        rate_before = page.evaluate(
            "() => document.querySelector('.tn-diag').textContent.match(/rate ([\\d.]+)/)?.[1]")
        check("calibrated before reload", not before["setup"] and before["bar"],
              f"rate {rate_before}")

        load()
        after = state()
        rate_after = page.evaluate(
            "() => document.querySelector('.tn-diag').textContent.match(/rate ([\\d.]+)/)?.[1]")
        check("restored automatically after reload",
              not after["setup"] and after["bar"], after["anchorState"][:70])
        check("same rate as before the reload", rate_before == rate_after,
              f"{rate_before} -> {rate_after}")
        check("says where it was restored from",
              "restored" in after["anchorState"] and "this browser" in after["anchorState"])

        # --- 2. a different cut must NOT inherit it -------------------------
        print("\n--- same stage, different recording (duration 14400s) ---")
        load(dur=14400)
        other = state()
        check("different cut is NOT auto-calibrated", other["setup"],
              other["anchorState"][:60])
        check("no calibration restored onto it",
              "restored" not in other["anchorState"])

        # calibrate this one too, then confirm the two coexist
        calibrate(150, 1000)
        load(dur=14400)
        check("the other cut restores its OWN calibration",
              "restored" in state()["anchorState"])
        load()
        check("original recording still restores too",
              "restored" in state()["anchorState"])

        stored = page.evaluate("""() => {
          const out = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.includes('tnCal:')) out[k] = JSON.parse(localStorage.getItem(k));
          }
          return out;
        }""")
        key = next(iter(stored), None)
        recs = stored.get(key, {}).get("recordings", []) if key else []
        check("both recordings stored under one (stage, site) key", len(recs) == 2,
              f"{key} -> {[r['duration_sec'] for r in recs]}")
        check("each record carries site + duration + anchors",
              all(r.get("site") and r.get("duration_sec") and r.get("anchors")
                  for r in recs))

        # --- 3. reset clears only this recording ---------------------------
        print("\n--- reset ---")
        page.click(".tn-anchor-clear")
        page.wait_for_timeout(300)
        check("reset returns to the setup prompt", state()["setup"])
        load()
        check("reset recording stays uncalibrated after reload", state()["setup"])
        load(dur=14400)
        check("the OTHER recording is untouched by that reset",
              "restored" in state()["anchorState"])

        # --- 4. lite stages calibrate too ----------------------------------
        print("\n--- lite (profile-only) stage 6 ---")
        load(stage=6)
        lite0 = state()
        check("lite stage shows the calibrate prompt", lite0["setup"])
        check("lite stage still draws its profile bar", lite0["bar"])
        # Uncalibrated it assumes the Peacock shape -- flag an hour in, then
        # the scheduled race duration at 0.92x -- so it already knows roughly
        # where in the recording you are and shows it. It used to draw no
        # playhead at all until two readings existed.
        check("uncalibrated lite stage still shows where you are watching",
              lite0["playhead"], lite0["anchorState"][:70])
        check("and says it is an assumption, not a measurement",
              "assuming" in lite0["anchorState"], lite0["anchorState"][:70])

        calibrate(150, 600)
        check("one reading is recorded, prompt still asking for a second",
              state()["setup"], state()["anchorState"][:60])
        calibrate(20, 9000, ".tn-togo-km2", ".tn-togo-set2")
        lite2 = state()
        check("two readings give the lite stage a playhead", lite2["playhead"],
              lite2["clock"])
        # ...and switch the bar from a distance axis to a RECORDING one, so
        # the profile occupies only the stretch of recording the race does.
        span = page.evaluate("""() => {
          const bar = document.querySelector('.tn-bar');
          const xs = d => [...d.matchAll(/([\\d.]+)\\s[\\d.]+/g)].map(m => parseFloat(m[1]));
          const all = [...bar.querySelectorAll('path')].flatMap(s => xs(s.getAttribute('d') || ''));
          return all.length ? { lo: Math.min(...all), hi: Math.max(...all),
                                w: bar.clientWidth } : null;
        }""")
        check("calibrated lite bar spans the race, not the whole recording",
              span and (span["lo"] > 1 or span["hi"] < span["w"] - 1),
              f"px {span['lo']:.0f}-{span['hi']:.0f} of {span['w']}" if span else "no path")
        check("lite diag reports the interpolation",
              "steady-pace" in lite2["diag"], lite2["diag"][:90])

        load(stage=6)
        check("lite calibration restores after reload",
              "restored" in state()["anchorState"] and state()["playhead"])

        # seeking through the distance<->time map
        page.evaluate("document.querySelector('video').currentTime = 0")
        page.wait_for_timeout(200)
        box = page.locator(".tn-bar").bounding_box()
        page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
        page.wait_for_timeout(300)
        t = page.evaluate("() => document.querySelector('video').currentTime")
        check("clicking a lite bar seeks the recording", t > 0, f"currentTime={t:.0f}s")

        # --- 5. adding a reading also contributes --------------------------
        # Two routes, and which one runs depends on the collector being
        # reachable -- so both are driven here rather than whichever the
        # shipped COLLECTOR_URL happens to select. The collector is never
        # really contacted: it is intercepted, so the suite neither depends on
        # the Worker being up nor writes anything to the live store.
        print("\n--- sharing rides on Add reading (no separate button) ---")
        check("there is no separate share button",
              not page.evaluate("() => !!document.querySelector('.tn-share')"))

        posted = []
        page.route("**/tour-calibrations*.workers.dev/**", lambda route: (
            posted.append(route.request.post_data),
            route.fulfill(status=200, content_type="application/json",
                          body='{"ok":true}')))
        load()
        calibrate(150, rec_for_kmto(150.5))
        calibrate(20, rec_for_kmto(20.5), ".tn-togo-km2", ".tn-togo-set2")
        check("a reading POSTs to the collector", len(posted) >= 1,
              f"{len(posted)} submission(s)")
        if posted:
            rec = json.loads(posted[-1])
            check("the payload is the calibration record",
                  rec.get("stage") == 14 and len(rec.get("anchors", [])) == 2
                  and rec.get("duration_sec", 0) > 0,
                  f"stage={rec.get('stage')} anchors={len(rec.get('anchors', []))}")
        check("no tab is opened when the collector accepts",
              not page.evaluate("() => window.__opens || []"))
        check("the panel says it shared",
              "shared" in state()["anchorState"], state()["anchorState"][-40:])

        # A failing collector must SAY it failed. Falling back to the issue
        # form looks identical whether none is configured, one is deployed but
        # erroring, or it is refusing this record -- and that ambiguity hid a
        # broken collector behind a working fallback for a while.
        page.unroute("**/tour-calibrations*.workers.dev/**")
        page.route("**/tour-calibrations*.workers.dev/**", lambda route:
                   route.fulfill(status=502, content_type="application/json",
                                 body='{"error":"Unexpected end of JSON input"}'))
        load(dur=12500)
        calibrate(150, 1500)
        said = state()["anchorState"]
        check("a failing collector names the failure", "502" in said, said[-70:])
        check("and quotes the reason it gave",
              "Unexpected end of JSON input" in said)

        # Collector unreachable -> the issue form has to take over, or an
        # offline viewer's calibration would be silently dropped.
        page.unroute("**/tour-calibrations*.workers.dev/**")
        page.route("**/tour-calibrations*.workers.dev/**", lambda route: route.abort())
        load(dur=11000)
        calibrate(150, 1500)
        opens = page.evaluate("() => window.__opens || []")
        check("a dead collector falls back to the issue form", len(opens) >= 1)
        if opens:
            check("fallback reuses ONE named tab, never stacking",
                  {t for _, t in opens} == {"tn-share"}, str({t for _, t in opens}))
            check("it points at the repo's issue form",
                  "/tour-scraper/issues/new" in opens[-1][0])
            check("payload carries the record",
                  "%60%60%60json" in opens[-1][0] or "```json" in opens[-1][0])
        page.click(".tn-togo-set2")   # empty input: nothing new to share
        page.wait_for_timeout(400)
        check("a no-op click does not re-offer it",
              len(page.evaluate("() => window.__opens || []")) == len(opens))

        check("no page errors", not errs, "; ".join(errs[:2]))
        br.close()
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)

print("\n" + ("ALL ASSERTIONS PASSED" if not failures
              else f"{len(failures)} FAILED: {failures}"))
sys.exit(1 if failures else 0)
