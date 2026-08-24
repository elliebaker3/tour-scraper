"""CLI for tour-scraper.

  python -m tourscraper probe                  # connectivity + payload peek
  python -m tourscraper bootstrap              # riders/teams/stages reference
  python -m tourscraper profiles               # elevation-profile CSVs
  python -m tourscraper live --stage 14        # record SSE live stream
  python -m tourscraper poll --stage 14        # poll configured endpoints
  python -m tourscraper radio --stage 14       # record radio stream
  python -m tourscraper stage --stage 14       # ALL of the above concurrently
  python -m tourscraper har capture.har        # discover endpoints from a HAR
  python -m tourscraper autodiscover           # same discovery, headless, no browser needed
  python -m tourscraper reparse data/2026/stage-14_2026-07-18
  python -m tourscraper vuelta-komoot-profiles # Vuelta route/elevation, via komoot
  python -m tourscraper startlist --stage 1    # per-rider departure/intermediate/arrival (ITT stages)
"""

from __future__ import annotations

import argparse
import threading
from datetime import datetime, timezone
from pathlib import Path

from .archive_stage import archive_stage
from .navigator.build_bundle import build as build_navigator
from .navigator.velowire_profile import build as build_velowire_profiles
from .navigator.velowire_profile import publish_lite_bundles
from .navigator.komoot_profile import build as build_komoot_profiles
from .navigator.komoot_profile import publish_lite_bundles as publish_komoot_bundles
from .navigator.startlist_scrape import run_loop as run_startlist_loop
from .autodiscover import run_autodiscover
from .backfill import reparse_backfill, run_backfill
from .events_parse import write_events
from .config import load_config
from .har_discover import analyze_har
from .live_stream import record_live, reparse
from .polling import poll_loop, record_radio
from .static_api import bootstrap, fetch_profiles, probe
from .storage import StageStore


def guess_stage_number(cfg) -> str:
    """Fallback when --stage isn't given: use the date so nothing is lost."""
    return datetime.now(timezone.utc).strftime("d%m%d")


def cmd_stage(cfg, args) -> None:
    """Run the full capture session for one stage: bootstrap once, then
    live SSE + polling + radio concurrently until --max-hours elapses."""
    bootstrap(cfg)
    fetch_profiles(cfg)
    store = StageStore(cfg.year_dir, args.stage or guess_stage_number(cfg),
                       part=getattr(args, "part", None))
    stop_after = int(args.max_hours * 3600)
    threads = [
        threading.Thread(target=record_live, args=(cfg, store, stop_after), daemon=True),
        threading.Thread(target=poll_loop, args=(cfg, store, stop_after, args.stage), daemon=True),
        threading.Thread(target=record_radio, args=(cfg, store, stop_after), daemon=True),
    ]
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("interrupted; writers flush per-line so data up to now is safe")


def main() -> None:
    parser = argparse.ArgumentParser(prog="tourscraper")
    parser.add_argument("--config", default=None, help="path to config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("probe")
    sub.add_parser("bootstrap")
    sub.add_parser("profiles")

    for name in ("live", "poll", "radio", "stage"):
        p = sub.add_parser(name)
        p.add_argument("--stage", default=None, help="stage number, e.g. 14")
        p.add_argument("--max-hours", type=float, default=6.5,
                       help="hard stop after this many hours (default 6.5)")
        p.add_argument("--part", default=None,
                       help="label this session's output files (telemetry.part-3.jsonl). "
                            "Chained capture jobs each pass their own, so no two "
                            "ever write the same file and a merge cannot pick a "
                            "loser -- see StageStore.")

    p = sub.add_parser("backfill")
    p.add_argument("--stages", default="1-12", help="e.g. 1-12 or 3,5,9")

    p = sub.add_parser("backfill-reparse")
    p.add_argument("stage_dir")

    p = sub.add_parser("har")
    p.add_argument("har_file")

    p = sub.add_parser("autodiscover")
    p.add_argument("--watch-seconds", type=int, default=150)
    p.add_argument("--no-apply", action="store_true",
                   help="save the inventory but don't patch config.yaml")

    p = sub.add_parser("reparse")
    p.add_argument("stage_dir")

    p = sub.add_parser("events")
    p.add_argument("stage_dir", help="e.g. data/2026/stage-14_2026-07-18")

    p = sub.add_parser("navigator")
    p.add_argument("--stage", type=int, required=True)
    p.add_argument("--stage-dir", required=True,
                   help="e.g. data/2026/stage-15_2026-07-19")
    p.add_argument("--telemetry", required=True, action="append",
                   help="GPS log; repeat to merge several captures (denser "
                        "sampling = better interpolation). Full-resolution logs "
                        "live outside git (~/tour-archive), over GitHub's 100MB cap")
    p.add_argument("--out", default=None)

    p = sub.add_parser("archive")
    p.add_argument("--stage", type=int, required=True)
    p.add_argument("--date", default=None, help="YYYY-MM-DD of the stage folder")

    sub.add_parser("velowire-profiles")

    p = sub.add_parser("vuelta-komoot-profiles")
    p.add_argument("--out", default="data/vuelta/2026", help="output dir (default data/vuelta/2026)")
    p.add_argument("--max-stage", type=int, default=21)
    p.add_argument("--refresh", action="store_true",
                   help="re-scrape lavuelta.es for tour ids instead of using the cached reference file")

    p = sub.add_parser("startlist",
                       help="scrape the racecenter's per-rider departure/intermediate/arrival "
                            "table (headless browser) -- for stages with an individual start, "
                            "e.g. an ITT, where there's no clean JSON endpoint for it")
    p.add_argument("--stage", type=int, required=True)
    p.add_argument("--max-hours", type=float, default=4.0)
    p.add_argument("--interval-seconds", type=float, default=120)

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.command == "backfill":
        run_backfill(cfg, args.stages)
    elif args.command == "backfill-reparse":
        reparse_backfill(cfg, args.stage_dir)
    elif args.command == "probe":
        probe(cfg)
    elif args.command == "bootstrap":
        bootstrap(cfg)
    elif args.command == "profiles":
        fetch_profiles(cfg)
    elif args.command == "har":
        analyze_har(cfg, args.har_file)
    elif args.command == "autodiscover":
        run_autodiscover(cfg, watch_seconds=args.watch_seconds, apply_config=not args.no_apply)
    elif args.command == "reparse":
        reparse(Path(args.stage_dir), cfg.year)
    elif args.command == "events":
        write_events(Path(args.stage_dir))
    elif args.command == "navigator":
        import glob as _glob
        tele = []
        for pat in args.telemetry:
            hits = sorted(_glob.glob(str(Path(pat).expanduser())))
            tele.extend(Path(h) for h in hits) if hits else tele.append(Path(pat).expanduser())
        build_navigator(Path(args.stage_dir), tele,
                        cfg.year_dir, args.stage,
                        Path(args.out) if args.out else None,
                        racecenter_base=cfg.base_url.rstrip("/") + "/api",
                        site_base=cfg.site_base_url)
    elif args.command == "archive":
        archive_stage(cfg, args.stage, args.date)
    elif args.command == "velowire-profiles":
        build_velowire_profiles(cfg.year_dir)
        publish_lite_bundles(cfg.year_dir / "profiles" / "velowire",
                             cfg.year_dir.parent.parent / "extension" / "data",
                             gpx_dir=cfg.year_dir / "gpx")
    elif args.command == "vuelta-komoot-profiles":
        build_komoot_profiles(Path(args.out), max_stage=args.max_stage, refresh=args.refresh)
        repo_root = Path(__file__).resolve().parents[2]
        publish_komoot_bundles(Path(args.out) / "profiles" / "komoot",
                               repo_root / "extension" / "data")
    elif args.command == "startlist":
        store = StageStore(cfg.year_dir, args.stage)
        run_startlist_loop(cfg.base_url, store.dir, args.max_hours * 3600,
                           interval_seconds=args.interval_seconds)
    else:
        store_needed = args.command in ("live", "poll", "radio")
        stop_after = int(args.max_hours * 3600)
        if args.command == "stage":
            cmd_stage(cfg, args)
        elif store_needed:
            store = StageStore(cfg.year_dir, args.stage or guess_stage_number(cfg),
                       part=getattr(args, "part", None))
            if args.command == "live":
                record_live(cfg, store, stop_after)
            elif args.command == "poll":
                poll_loop(cfg, store, stop_after, args.stage)
            elif args.command == "radio":
                record_radio(cfg, store, stop_after)


if __name__ == "__main__":
    main()
