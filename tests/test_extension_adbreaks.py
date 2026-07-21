"""Ad-break-aware calibration.

The recording runs at rate 1 through content; at each ad break the race jumps
forward by K x (break duration) -- the live race that played out under the ads
and is missing from the recording. The extension reads the break LOCATIONS from
an injected cvsdk-event-track, so:

  * with K = 1 (each break loses exactly its own length -- the physical case),
    ONE reading fixes the origin and the whole stage is placed accurately;
  * with K != 1, a SECOND reading past a break recovers K.

Accuracy is checked across every region, including breaks no reading bracketed.
"""
import json, re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
PORT = 8933

bundle = json.loads((EXT / "data" / "stage-14.json").read_text())
obs = [p for p in bundle["profile"] if p.get("t") and not p.get("est")]
first_obs = min(datetime.fromisoformat(p["t"]).timestamp() for p in obs)
obs_max = max(p["kmto"] for p in obs) - 2
obs_min = min(p["kmto"] for p in obs) + 2

BREAKS = [(3000.0, 90.0), (6000.0, 90.0), (10000.0, 90.0)]   # (rec start, duration)
R0_TRUE = first_obs - 300                                    # race-sec at rec 0

_REG = [(-1e9, BREAKS[0][0], 0.0)]
_cum = 0.0
for _i, (_t, _d) in enumerate(BREAKS):
    _cum += _d
    _REG.append((_t + _d, BREAKS[_i + 1][0] if _i + 1 < len(BREAKS) else 1e9, _cum))


def time_at_kmto(km):
    pts = sorted((p for p in bundle["profile"] if p.get("t")), key=lambda p: p["kmto"])
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if a["kmto"] <= km <= b["kmto"]:
            ta = datetime.fromisoformat(a["t"]).timestamp()
            tb = datetime.fromisoformat(b["t"]).timestamp()
            s = b["kmto"] - a["kmto"]
            return ta + (tb - ta) * ((km - a["kmto"]) / s if s else 0)
    return None


def rec_for_kmto(km, k):
    R = time_at_kmto(km + 0.5)
    for lo, hi, C in _REG:
        rec = R - R0_TRUE - k * C
        if lo <= rec < hi:
            return rec, _REG.index((lo, hi, C))
    return None, None


usable = lambda km: obs_min <= km + 0.5 <= obs_max and time_at_kmto(km + 0.5) is not None


def run(page, show, k, readings):
    """Calibrate with `readings` readings for a recording with loss factor k,
    then return the worst km-to-go error across the whole stage."""
    def set_rec(km):
        rec, _ = rec_for_kmto(km, k)
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec}")

    def region(km):
        return rec_for_kmto(km, k)[1]

    r0 = next(km for km in range(int(obs_max), 0, -1) if usable(km) and region(km) == 0)
    set_rec(r0); page.fill(".tn-togo-km", str(r0)); page.click(".tn-togo-set")
    page.wait_for_timeout(600); show()
    if readings >= 2:
        r1 = next(km for km in range(int(obs_max), 0, -1) if usable(km) and region(km) == 1)
        set_rec(r1); page.fill(".tn-togo-km2", str(r1)); page.click(".tn-togo-set2")
        page.wait_for_timeout(600); show()

    diag = page.evaluate("() => document.querySelector('.tn-diag').textContent")
    assert "3 ad breaks (from player)" in diag, f"FAIL: breaks not read: {diag}"

    worst = 0.0
    for km in range(int(obs_max), int(obs_min), -12):
        if not usable(km):
            continue
        rec, reg = rec_for_kmto(km, k)
        if rec is None or rec < 0 or rec > 19225:
            continue
        page.evaluate(f"() => document.querySelector('video').currentTime = {rec}")
        page.wait_for_timeout(600)                 # clear the 500ms render tick
        c = page.evaluate("() => document.querySelector('.tn-clock').textContent")
        m = re.search(r"([\d.]+) km to go", c)
        if not m:
            continue
        off = abs(float(m.group(1)) - (km + 0.5))
        worst = max(worst, off)
        assert off <= 1.5, f"FAIL: {off:.1f} km off at {km} km to go (region {reg}, k={k})"
    return worst, diag


harness = EXT / "_harness.html"
shutil.copy(ROOT / "tests" / "extension_harness.html", harness)
adparam = ",".join(f"{t}-{d}" for t, d in BREAKS)
srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", str(EXT)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/data/index.json", timeout=1)
            break
        except Exception:
            time.sleep(0.1)

    base = (f"http://127.0.0.1:{PORT}/_harness.html?stage=14&video=1&playbackstate=1"
            f"&adbreaks={adparam}")
    with sync_playwright() as p:
        br = p.chromium.launch()
        page = br.new_page(viewport={"width": 1400, "height": 800})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base)
        page.wait_for_selector(".tn-root", timeout=10000)
        page.wait_for_timeout(1000)
        show = lambda: page.evaluate(
            "() => document.querySelector('.tn-root').classList.remove('tn-hidden')")
        show()

        # ONE reading, k = 1 (the physical case): whole stage accurate.
        worst1, d1 = run(page, show, k=1.0, readings=1)
        print(f"one reading,  k=1.0: worst {worst1:.2f} km · {d1.split(' · ',2)[1]}")

        page.click(".tn-anchor-clear"); page.wait_for_timeout(400); show()

        # TWO readings recover a non-unit loss factor (k = 0.8).
        worst2, d2 = run(page, show, k=0.8, readings=2)
        print(f"two readings, k=0.8: worst {worst2:.2f} km · {d2.split(' · ',2)[1]}")

        print(f"\npage errors: {errs or 'none'}")
        assert not errs, f"FAIL: page errors {errs}"
        br.close()
    print("\nALL ASSERTIONS PASSED")
finally:
    srv.terminate()
    harness.unlink(missing_ok=True)
