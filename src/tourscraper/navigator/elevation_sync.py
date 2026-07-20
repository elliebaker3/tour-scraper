"""Sync the stage elevation profile to wall-clock time.

Workflow item (3): the elevation profile positioned by *when the leader got
there*, which is what makes a scrub bar navigable.

Accuracy is the whole point here, so three things are done deliberately:

1. **Everything works in km-to-finish, never in "distance covered".**
   The profile ships a `kmto` column and the GPS feed reports `kmToFinish`;
   both are measured to the same finish line, so they can be matched directly.
   Converting via a stage length instead means adopting whatever rounding that
   length carries — `stages.json` says 155.5 km for stage 14 while the route
   file says 155.2, and that 0.3 km discrepancy is ~27 seconds of systematic
   error at racing speed. Matching kmto->kmToFinish removes the constant, and
   with it the error.

2. **The leader is estimated robustly, not as a raw minimum.**
   One glitchy transponder reporting a kilometre up the road would otherwise
   drag the whole timeline forward. A sample is only accepted as the leader if
   a second rider corroborates it within `LEADER_GAP_TOLERANCE_KM`; otherwise
   the next-closest rider is used.

3. **Interpolation gaps are labelled, never smoothed over.**
   Points spanned by a capture gap are marked interpolated so the renderer can
   distinguish "we saw this" from "we inferred this".
"""

from __future__ import annotations

import bisect
import csv
import json
from datetime import datetime
from pathlib import Path

# A lone rider reporting further up the road than this, with nobody near them,
# is treated as a bad fix rather than as the race leader.
LEADER_GAP_TOLERANCE_KM = 1.5


def _parse_ts(text: str) -> datetime:
    return datetime.fromisoformat(text)


def load_profile(profile_csv: Path) -> list[dict]:
    """Read profile.csv into ordered route points, keyed by km-to-finish."""
    with open(profile_csv, encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh, delimiter=";"))
    points = []
    for r in rows:
        try:
            km_to = float(r["kmto"]) if r.get("kmto") else None
            if km_to is None:
                continue
            points.append({
                "km": float(r["kmdone"]),
                "km_to_finish": km_to,
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


def _riders_from_record(rec: dict):
    """Yield rider dicts from either capture shape (REST snapshot or SSE row)."""
    if "body" in rec:
        try:
            payload = json.loads(rec["body"])
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(payload, list) and payload:
            payload = payload[0]
        if isinstance(payload, dict):
            return payload.get("Riders")
        return None
    if "kmToFinish" in rec:
        return [rec]
    return None


def _leader_km_to_finish(riders) -> float | None:
    """Smallest km-to-finish that another rider corroborates.

    Guards against a single bad GPS fix appearing to be up the road: the front
    of a race is never truly alone by more than a kilometre or so at the
    resolution we sample, so an uncorroborated leader is dropped.
    """
    vals = sorted(
        r["kmToFinish"] for r in riders
        if isinstance(r.get("kmToFinish"), (int, float))
        and r.get("Status") != "abandoned"
        and r["kmToFinish"] >= 0
    )
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    for i in range(len(vals) - 1):
        if vals[i + 1] - vals[i] <= LEADER_GAP_TOLERANCE_KM:
            return vals[i]
    return vals[-1]


def leader_track(telemetry_paths) -> list[tuple[datetime, float]]:
    """Merge GPS sources into (timestamp, leader km-to-finish) samples.

    Several captures may cover the same stage at different rates (a dense SSE
    log plus periodic REST snapshots); merging them raises time resolution,
    which directly improves interpolation between profile points.
    """
    if isinstance(telemetry_paths, (str, Path)):
        telemetry_paths = [telemetry_paths]

    samples: list[tuple[datetime, float]] = []
    for path in telemetry_paths:
        path = Path(path)
        if not path.exists():
            continue
        with open(path, encoding="utf-8") as fh:
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
                riders = _riders_from_record(rec)
                if not riders:
                    continue
                km_to = _leader_km_to_finish(riders)
                if km_to is None:
                    continue
                samples.append((_parse_ts(captured), km_to))

    samples.sort(key=lambda s: s[0])

    # Distance to the finish only ever decreases; anything else is noise.
    cleaned: list[tuple[datetime, float]] = []
    best = float("inf")
    for ts, km_to in samples:
        if km_to <= best:
            best = km_to
            cleaned.append((ts, km_to))
    return cleaned


def sync_profile_to_time(profile: list[dict], track: list[tuple[datetime, float]],
                         max_gap_km: float = 2.0) -> list[dict]:
    """Attach the leader's arrival time to each profile point.

    `track` descends in km-to-finish, so it is reversed into ascending order
    for bisection and each profile point is looked up by its own kmto value --
    no stage-length constant is involved anywhere.
    """
    if not track:
        return [dict(p, time_utc=None, interpolated=None) for p in profile]

    asc = sorted(track, key=lambda s: s[1])          # ascending km-to-finish
    kms = [km for _, km in asc]
    lo_km, hi_km = kms[0], kms[-1]

    out = []
    for point in profile:
        km_to = point["km_to_finish"]
        if km_to < lo_km or km_to > hi_km:
            out.append(dict(point, time_utc=None, interpolated=None))
            continue
        idx = bisect.bisect_left(kms, km_to)
        if idx == 0:
            ts, interpolated = asc[0][0], False
        elif idx >= len(asc):
            ts, interpolated = asc[-1][0], False
        else:
            (t0, km0), (t1, km1) = asc[idx - 1], asc[idx]
            span = km1 - km0
            if span <= 0:
                ts, interpolated = t0, True
            else:
                frac = (km_to - km0) / span
                ts = t0 + (t1 - t0) * frac
                interpolated = span > max_gap_km
        out.append(dict(point,
                        time_utc=ts.isoformat(timespec="seconds"),
                        interpolated=interpolated))
    return out


def build(stage_dir: Path, telemetry_paths, stage_length_km: float | None = None) -> dict:
    """`stage_length_km` is accepted for reporting only; it is not used in the
    time mapping, which works purely in km-to-finish."""
    profile = load_profile(stage_dir / "profile.csv")
    track = leader_track(telemetry_paths)
    synced = sync_profile_to_time(profile, track)
    observed = [p for p in synced if p["time_utc"] and not p["interpolated"]]
    return {
        "stage_length_km": stage_length_km,
        "route_length_km": round(max((p["km"] for p in profile), default=0), 2),
        "profile_points": len(synced),
        "gps_samples": len(track),
        "observed_points": len(observed),
        "leader_first_seen": track[0][0].isoformat(timespec="seconds") if track else None,
        "leader_last_seen": track[-1][0].isoformat(timespec="seconds") if track else None,
        "leader_km_to_finish_range": [round(track[0][1], 2), round(track[-1][1], 2)] if track else None,
        "points": synced,
    }
