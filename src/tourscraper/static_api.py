"""Scrape the static/reference data: riders, teams, stages, and the
elevation-profile CSVs (route points) for each stage.

The stage payload from /api/stage-{year} has, in past years, carried per-stage
metadata; profile CSV paths look like /profils/{year}/profile-NN-<hash>.csv and
are sometimes referenced from the stage payload and sometimes only from the
racecenter page markup/bundle, so we hunt in both places.
"""

from __future__ import annotations

import json
import re
import time

import requests

from .config import Config
from .storage import StageStore, save_reference, utcnow

PROFILE_RE = re.compile(r"/profils/\d{4}/profile-[\w.\-]+?\.csv")


def make_session(cfg: Config) -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": cfg.user_agent,
            "Accept": "application/json, text/plain, */*",
            "Referer": cfg.base_url + "/en/",
        }
    )
    return s


def get_with_retry(session: requests.Session, cfg: Config, url: str, **kw) -> requests.Response:
    last_exc = None
    for backoff in [0] + list(cfg.retry_backoff_seconds):
        if backoff:
            time.sleep(backoff)
        try:
            resp = session.get(url, timeout=cfg.timeout_seconds, **kw)
            if resp.status_code < 500:
                return resp
            last_exc = RuntimeError(f"HTTP {resp.status_code} from {url}")
        except requests.RequestException as exc:  # noqa: PERF203
            last_exc = exc
    raise last_exc


def fetch_json(session: requests.Session, cfg: Config, endpoint_template: str):
    url = cfg.url(endpoint_template)
    resp = get_with_retry(session, cfg, url)
    resp.raise_for_status()
    return resp.json()


def bootstrap(cfg: Config) -> dict:
    """Fetch riders, teams, stages; save under data/{year}/reference/."""
    session = make_session(cfg)
    results = {}
    for name, endpoint in [
        ("riders", cfg.competitors_endpoint),
        ("teams", cfg.teams_endpoint),
        ("stages", cfg.stages_endpoint),
    ]:
        try:
            payload = fetch_json(session, cfg, endpoint)
            path = save_reference(cfg.year_dir, name, payload)
            results[name] = {"ok": True, "path": str(path)}
            print(f"[bootstrap] saved {name} -> {path}")
        except Exception as exc:  # keep going; partial reference data is useful
            results[name] = {"ok": False, "error": str(exc)}
            print(f"[bootstrap] FAILED {name}: {exc}")
    return results


def discover_profile_urls(cfg: Config, session: requests.Session | None = None) -> list[str]:
    """Find elevation-profile CSV URLs from the stages payload and page markup."""
    session = session or make_session(cfg)
    found: set[str] = set()

    stages_path = cfg.year_dir / "reference" / "stages.json"
    if stages_path.exists():
        found.update(PROFILE_RE.findall(stages_path.read_text()))

    # Also scan the racecenter landing page and any JS bundles it references.
    try:
        page = get_with_retry(session, cfg, cfg.base_url + "/en/").text
        found.update(PROFILE_RE.findall(page))
        for script_src in re.findall(r'src="(/[^"]+?\.js)"', page)[:15]:
            try:
                bundle = get_with_retry(session, cfg, cfg.base_url + script_src).text
                found.update(PROFILE_RE.findall(bundle))
            except Exception:
                continue
    except Exception as exc:
        print(f"[profiles] page scan failed: {exc}")

    return sorted(cfg.base_url + p for p in found)


def fetch_profiles(cfg: Config) -> None:
    """Download every discoverable profile CSV into its stage folder (or a
    shared profiles folder when the stage number can't be parsed)."""
    session = make_session(cfg)
    urls = discover_profile_urls(cfg, session)
    if not urls:
        print(
            "[profiles] none discovered automatically. As of 2026 this CSV path "
            "appears to be gone from the site (confirmed: no /profils or .csv "
            "references in the app bundle, no profile field on any stage in "
            "/api/stage-2026) — this isn't just a live-vs-not-live timing issue. "
            "Open the racecenter in your browser during a stage, export a HAR "
            "(see README), then run: python -m tourscraper har <file.har> to find "
            "the real 2026 mechanism."
        )
        return
    shared = cfg.year_dir / "profiles"
    shared.mkdir(parents=True, exist_ok=True)
    for url in urls:
        fname = url.rsplit("/", 1)[-1]
        m = re.search(r"profile-(\d+)", fname)
        dest = shared / fname
        try:
            resp = get_with_retry(session, cfg, url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
            print(f"[profiles] saved {dest} ({len(resp.content)} bytes)")
            if m:
                store = StageStore(cfg.year_dir, int(m.group(1)))
                (store.dir / "profile.csv").write_bytes(resp.content)
                store.write_manifest({"kind": "profile", "source": url})
        except Exception as exc:
            print(f"[profiles] FAILED {url}: {exc}")
        time.sleep(1)  # be polite


def probe(cfg: Config) -> None:
    """Quick connectivity/shape check: hit each endpoint, print status + a peek."""
    session = make_session(cfg)
    targets = {
        "riders": cfg.url(cfg.competitors_endpoint),
        "teams": cfg.url(cfg.teams_endpoint),
        "stages": cfg.url(cfg.stages_endpoint),
        "live-stream (headers only)": cfg.base_url + cfg.live_stream_endpoint,
    }
    for name, url in targets.items():
        try:
            stream = "live-stream" in name
            resp = session.get(url, timeout=cfg.timeout_seconds, stream=stream)
            peek = "" if stream else resp.text[:120].replace("\n", " ")
            print(f"[probe] {name}: HTTP {resp.status_code} "
                  f"content-type={resp.headers.get('content-type')} {peek}")
            if stream:
                resp.close()
        except Exception as exc:
            print(f"[probe] {name}: FAILED {exc}")
    print(f"[probe] finished at {utcnow()}")
