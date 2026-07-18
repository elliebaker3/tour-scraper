"""CLI for tour-scraper.

  python -m tourscraper probe                  # connectivity + payload peek
  python -m tourscraper bootstrap              # riders/teams/stages reference
  python -m tourscraper profiles               # elevation-profile CSVs
  python -m tourscraper live --stage 14        # record SSE live stream
  python -m tourscraper poll --stage 14        # poll configured endpoints
  python -m tourscraper radio --stage 14       # record radio stream
  python -m tourscraper stage --stage 14       # ALL of the above concurrently
  python -m tourscraper har capture.har        # discover endpoints from a HAR
  python -m tourscraper reparse data/2026/stage-14_2026-07-18
"""

from __future__ import annotations

import argparse
import threading
from datetime import datetime, timezone
from pathlib import Path

from .backfill import reparse_backfill, run_backfill
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
    store = StageStore(cfg.year_dir, args.stage or guess_stage_number(cfg))
    stop_after = int(args.max_hours * 3600)
    threads = [
        threading.Thread(target=record_live, args=(cfg, store, stop_after), daemon=True),
        threading.Thread(target=poll_loop, args=(cfg, store, stop_after), daemon=True),
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

    p = sub.add_parser("backfill")
    p.add_argument("--stages", default="1-12", help="e.g. 1-12 or 3,5,9")

    p = sub.add_parser("backfill-reparse")
    p.add_argument("stage_dir")

    p = sub.add_parser("har")
    p.add_argument("har_file")

    p = sub.add_parser("reparse")
    p.add_argument("stage_dir")

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
    elif args.command == "reparse":
        reparse(Path(args.stage_dir), cfg.year)
    else:
        store_needed = args.command in ("live", "poll", "radio")
        stop_after = int(args.max_hours * 3600)
        if args.command == "stage":
            cmd_stage(cfg, args)
        elif store_needed:
            store = StageStore(cfg.year_dir, args.stage or guess_stage_number(cfg))
            if args.command == "live":
                record_live(cfg, store, stop_after)
            elif args.command == "poll":
                poll_loop(cfg, store, stop_after)
            elif args.command == "radio":
                record_radio(cfg, store, stop_after)


if __name__ == "__main__":
    main()
