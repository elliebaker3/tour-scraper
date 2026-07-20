"""Assemble one self-contained JSON bundle per stage for the Tour Navigator.

The browser extension loads exactly one of these files and needs nothing else,
so everything it draws or seeks to has to be in here: stage metadata, the
time-synced elevation profile, the guideposts, and the intensity curve.

Two deliberate choices:

* Distances are metres of elapsed route and every time is UTC ISO-8601. The
  extension converts UTC -> position-in-recording using the viewer's two-point
  anchor; keeping a single unambiguous clock in the data means a wrong anchor
  is a visible offset rather than a silent, timezone-shaped error.

* The profile is downsampled for rendering. A scrub bar is ~1000px wide, so
  1800+ route points is far more than can be seen; we keep peaks and troughs
  (never smoothing away a summit) and drop redundant points in between.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .elevation_sync import build as build_sync
from .extract_events import build_guideposts, load_ticker


def downsample_profile(points: list[dict], target: int = 500) -> list[dict]:
    """Thin the profile for drawing while preserving local extremes.

    Plain every-Nth sampling can land either side of a col and flatten it, so
    each bucket contributes its highest and lowest point; summits and valley
    floors therefore survive at any target size.
    """
    timed = [p for p in points if p.get("time_utc")]   # includes estimated head
    if len(timed) <= target:
        return timed
    bucket = max(1, len(timed) // (target // 2))
    out: list[dict] = []
    for i in range(0, len(timed), bucket):
        chunk = timed[i:i + bucket]
        if not chunk:
            continue
        hi = max(chunk, key=lambda p: p["altitude"])
        lo = min(chunk, key=lambda p: p["altitude"])
        for p in sorted({id(hi): hi, id(lo): lo}.values(), key=lambda p: p["km"]):
            if not out or out[-1]["km"] != p["km"]:
                out.append(p)
    return out


def _slim(p: dict) -> dict:
    """Only the fields the renderer reads, rounded to keep the bundle small."""
    return {
        "km": round(p["km"], 2),
        "kmto": round(p["km_to_finish"], 2),
        "alt": round(p["altitude"]),
        "t": p["time_utc"],
        "interp": bool(p.get("interpolated")),
        "est": bool(p.get("estimated")),
        "cat": p.get("climb_category") or None,
        "cp": p.get("checkpoint_type") or None,
    }


def stage_meta(cfg_year_dir: Path, stage_number: int) -> dict:
    """Pull this stage's row out of the bootstrapped reference data."""
    path = cfg_year_dir / "reference" / "stages.json"
    if not path.exists():
        return {}
    for s in json.loads(path.read_text(encoding="utf-8")):
        if s.get("stage") == stage_number:
            return {
                "stage": s.get("stage"),
                "date": str(s.get("date", ""))[:10],
                "type": s.get("type"),
                "length_km": s.get("lengthDisplay") or s.get("length"),
                "start_local": s.get("startTime"),
                "end_local": s.get("endTime"),
                "timezone": s.get("timezone"),
                "departure": (s.get("departureCity") or {}).get("label"),
                "arrival": (s.get("arrivalCity") or {}).get("label"),
            }
    return {}


def actual_start_utc(stage_dir: Path):
    """Time the stage actually rolled, from the ticker's own start marker."""
    for item in load_ticker(stage_dir):
        if item.get("picto") == "liv_actual_start" and item.get("t"):
            try:
                return datetime.fromisoformat(item["t"]).astimezone(timezone.utc)
            except ValueError:
                return None
    return None


def scheduled_start_utc(meta: dict):
    """Fallback: the published start time, if the ticker never marked one."""
    date, start, tz = meta.get("date"), meta.get("start_local"), meta.get("timezone")
    if not (date and start):
        return None
    try:
        from zoneinfo import ZoneInfo
        naive = datetime.fromisoformat(f"{date}T{start}")
        return naive.replace(tzinfo=ZoneInfo(tz or "UTC")).astimezone(timezone.utc)
    except Exception:
        return None


# ASO's climb grades, hardest first. "H" is hors catégorie.
_KOM_LABEL = {"H": "HC", "1": "Cat 1", "2": "Cat 2", "3": "Cat 3", "4": "Cat 4"}


def route_markers(sync_points: list[dict]) -> list[dict]:
    """Intermediate sprints and categorized climbs, from the official profile.

    These come straight from ASO's route data (the same public source as the
    printed stage profile), not from the ticker, so they are always present and
    exactly placed. Each is timed by when the leader reached it and carries its
    own km / km-to-go / altitude, so the renderer can pin it on the elevation
    curve regardless of how the profile is downsampled -- which on stage 15 had
    dropped every one of them.
    """
    # A summit finish sits at km-to-go 0, which can fall just past GPS coverage
    # and so carry no leader time of its own; the finish time is simply when the
    # leader last had a fix, i.e. crossed the line.
    finish_t = next((p["time_utc"] for p in reversed(sync_points)
                     if p.get("time_utc")), None)

    out = []
    for p in sync_points:
        cptype = (p.get("checkpoint_type") or "")
        cat = p.get("climb_category")
        km, kmto, alt = p.get("km"), p.get("km_to_finish"), p.get("altitude")
        t = p.get("time_utc")
        common = {"km": round(km, 1) if km is not None else None,
                  "kmto": round(kmto, 1) if kmto is not None else None,
                  "alt": round(alt) if alt is not None else None,
                  "t": t}
        if "sprint" in cptype:
            out.append({**common, "kind": "sprint", "label": "Intermediate sprint"})
        if cat in _KOM_LABEL:
            summit_finish = "arrival" in cptype
            out.append({**common, "t": common["t"] or (finish_t if summit_finish else None),
                        "kind": "kom", "cat": _KOM_LABEL[cat],
                        "label": ("Summit finish" if summit_finish
                                  else f"Climb — {_KOM_LABEL[cat]}"),
                        "finish": summit_finish})
    # One row per (kind, km); the profile can list a checkpoint on adjacent points.
    seen, dedup = set(), []
    for m in sorted(out, key=lambda m: (m["km"] if m["km"] is not None else 1e9)):
        key = (m["kind"], m["km"])
        if key not in seen:
            seen.add(key)
            dedup.append(m)
    return dedup


def build(stage_dir: Path, telemetry_paths, year_dir: Path,
          stage_number: int, out_path: Path | None = None) -> Path:
    meta = stage_meta(year_dir, stage_number)
    length_km = float(meta.get("length_km") or 0) or None
    if not length_km:
        raise SystemExit(f"stage {stage_number}: no length in stages.json; run bootstrap first")

    # The real km-0 moment. The ticker tags it (liv_actual_start) and it can
    # differ from the schedule by minutes -- stage 14 rolled 5m38s late -- so
    # prefer it over stages.json for extending the profile to the start line.
    race_start = actual_start_utc(stage_dir) or scheduled_start_utc(meta)
    sync = build_sync(stage_dir, telemetry_paths, length_km, race_start_utc=race_start)
    events = build_guideposts(stage_dir, sync["points"])
    profile = [_slim(p) for p in downsample_profile(sync["points"])]
    markers = route_markers(sync["points"])

    bundle = {
        "schema": 1,
        "stage": meta,
        "coverage": {
            "gps_samples": sync["gps_samples"],
            "route_length_km": sync.get("route_length_km"),
            "leader_km_to_finish_range": sync.get("leader_km_to_finish_range"),
            "profile_points_total": sync["profile_points"],
            "profile_points_observed": sync["observed_points"],
            "profile_points_estimated": sync.get("estimated_points"),
            "profile_points_timed": sync.get("timed_points"),
            "race_start_utc": race_start.isoformat(timespec="seconds") if race_start else None,
            "leader_first_seen_utc": sync["leader_first_seen"],
            "leader_last_seen_utc": sync["leader_last_seen"],
            "ticker_items": events["ticker_items"],
        },
        "profile": profile,
        "route_markers": markers,
        "guideposts": events["guideposts"],
        "intensity": events["intensity"],
    }

    out_path = out_path or (stage_dir / "navigator.json")
    out_path.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))
    kb = out_path.stat().st_size / 1024
    print(f"[navigator] stage {stage_number} -> {out_path} ({kb:.0f} KB)")
    print(f"[navigator]   profile {len(profile)} pts (of {sync['profile_points']}), "
          f"{sync['observed_points']} time-observed")
    print(f"[navigator]   guideposts {events['counts']}")
    sprints = sum(1 for m in markers if m["kind"] == "sprint")
    koms = sum(1 for m in markers if m["kind"] == "kom")
    print(f"[navigator]   route markers: {sprints} sprint(s), {koms} climb(s)")
    return out_path
