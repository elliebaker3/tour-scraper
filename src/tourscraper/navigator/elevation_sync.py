"""Sync the stage elevation profile to wall-clock time.

This answers workflow item (3): "the elevation profile of the race synced to
the time the first rider reaches that elevation."

Inputs
  profile.csv            1 row per ~100m of route: kmdone, altitude, slope,
                         lat/lon, plus checkpoint markers (cpnumero/cptype/
                         sumcategory) for sprints, summits and the finish.
  telemetry (GPS)        per-rider snapshots carrying kmToFinish, so the race
                         leader's distance-covered is directly observable.

Method
  For every GPS snapshot we take the leader as the rider with the smallest
  kmToFinish (equivalently the largest distance covered) among riders actually
  racing. That yields samples of (time -> km covered). Race distance only ever
  increases, so we enforce monotonicity (a straggler transponder or a noisy
  fix can otherwise make the leader appear to go backwards), then invert the
  relation: for each profile point we interpolate the time the leader first
  reached that km.

  Gaps in capture are handled honestly. If the leader jumps across a stretch
  of road between two snapshots more than `max_gap_km` apart, the points in
  between are marked interpolated=True rather than silently presented as
  observed, so the Navigator can render them differently (or the caller can
  drop them).
"""

from __future__ import annotations

import bisect
import csv
import json
from datetime import datetime
from pathlib import Path


def _parse_ts(text: str) -> datetime:
    return datetime.fromisoformat(text)


def load_profile(profile_csv: Path) -> list[dict]:
    """Read profile.csv into ordered route points."""
    with open(profile_csv, encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh, delimiter=";"))
    points = []
    for r in rows:
        try:
            points.append({
                "km": float(r["kmdone"]),
                "km_to_finish": float(r["kmto"]) if r.get("kmto") else None,
                "altitude": float(r["altitude"]),
                "slope": float(r["slope"]) if r.get("slope") else None,
                "lat": float(r["latitude"]) if r.get("latitude") else None,
                "lon": float(r["longitude"]) if r.get("longitude") else None,
                "checkpoint": r.get("cpnumero") or None,
                "checkpoint_type": r.get("cptype") or None,
                "climb_category": r.get("sumcategory") or None,
            })
        except (KeyError, ValueError):
            continue
    points.sort(key=lambda p: p["km"])
    return points


def leader_track(telemetry_path: Path, stage_length_km: float) -> list[tuple[datetime, float]]:
    """Extract (timestamp, km_covered_by_leader) from GPS snapshots.

    Accepts either shape we capture: the REST poll log (one line per snapshot,
    with a JSON `body` holding all riders) or the SSE log (one line per rider).
    """
    samples: list[tuple[datetime, float]] = []
    with open(telemetry_path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            captured = rec.get("captured_at")
            if not captured:
                continue

            riders = None
            if "body" in rec:  # REST poll snapshot
                try:
                    payload = json.loads(rec["body"])
                except (json.JSONDecodeError, TypeError):
                    continue
                if isinstance(payload, list) and payload:
                    payload = payload[0]
                if isinstance(payload, dict):
                    riders = payload.get("Riders")
            elif "kmToFinish" in rec:  # single parsed rider row (SSE)
                riders = [rec]

            if not riders:
                continue
            remaining = [
                r["kmToFinish"] for r in riders
                if isinstance(r.get("kmToFinish"), (int, float))
                and r.get("Status") != "abandoned"
            ]
            if not remaining:
                continue
            covered = stage_length_km - min(remaining)
            if 0 <= covered <= stage_length_km + 1:
                samples.append((_parse_ts(captured), covered))

    samples.sort(key=lambda s: s[0])
    # Enforce monotonic progress: distance covered cannot decrease.
    cleaned: list[tuple[datetime, float]] = []
    best = float("-inf")
    for ts, km in samples:
        if km >= best:
            best = km
            cleaned.append((ts, km))
    return cleaned


def sync_profile_to_time(profile: list[dict], track: list[tuple[datetime, float]],
                         max_gap_km: float = 2.0) -> list[dict]:
    """Attach the leader's arrival time to each profile point."""
    if not track:
        return [dict(p, time_utc=None, interpolated=None) for p in profile]

    kms = [km for _, km in track]
    out = []
    for point in profile:
        km = point["km"]
        idx = bisect.bisect_left(kms, km)
        if idx == 0:
            out.append(dict(point, time_utc=None, interpolated=None))
            continue
        if idx >= len(track):
            out.append(dict(point, time_utc=None, interpolated=None))
            continue
        (t0, km0), (t1, km1) = track[idx - 1], track[idx]
        span = km1 - km0
        if span <= 0:
            arrival, interpolated = t0, True
        else:
            frac = (km - km0) / span
            arrival = t0 + (t1 - t0) * frac
            interpolated = span > max_gap_km
        out.append(dict(point,
                        time_utc=arrival.isoformat(timespec="seconds"),
                        interpolated=interpolated))
    return out


def build(stage_dir: Path, telemetry_path: Path, stage_length_km: float) -> dict:
    profile = load_profile(stage_dir / "profile.csv")
    track = leader_track(telemetry_path, stage_length_km)
    synced = sync_profile_to_time(profile, track)
    observed = [p for p in synced if p["time_utc"] and not p["interpolated"]]
    result = {
        "stage_length_km": stage_length_km,
        "profile_points": len(synced),
        "gps_samples": len(track),
        "observed_points": len(observed),
        "leader_first_seen": track[0][0].isoformat(timespec="seconds") if track else None,
        "leader_last_seen": track[-1][0].isoformat(timespec="seconds") if track else None,
        "points": synced,
    }
    return result
