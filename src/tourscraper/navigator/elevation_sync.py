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
from datetime import datetime, timezone
from pathlib import Path

# A lone rider reporting further up the road than this, with nobody near them,
# is treated as a bad fix rather than as the race leader.
LEADER_GAP_TOLERANCE_KM = 1.5

# Above this, a "position" is a bad fix rather than a rider. Tour descents do
# touch 90 km/h in bursts, so the limit sits above that deliberately: the job
# here is rejecting the impossible, not second-guessing a fast descent.
MAX_SPEED_KMH = 95.0


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


# Sanity window for a feed-supplied epoch: 2020-09 .. 2033-05. A TimeStamp
# outside it is some other kind of number and is not trusted as a clock.
_EPOCH_MIN, _EPOCH_MAX = 1_600_000_000, 2_000_000_000


def _sample_from_record(rec: dict):
    """Return (timestamp, riders) from either capture shape.

    The timestamp comes from the payload's own `TimeStamp` whenever it is
    present, NOT from when we happened to receive it. Those are not the same
    thing: the CDN in front of the telemetry API serves stale cached responses,
    and on stage 14 it served a payload frozen at 12:25 right up to 13:01 --
    by which point our capture clock said the leader was 30 minutes behind
    where he actually was. Trusting `captured_at` put the field at km 31 at
    12:50 (25 km/h) and then teleported it 24 km in 61 seconds when a fresh
    response finally arrived. `TimeStamp` places both readings correctly.

    It also removes a systematic error on every ordinary sample: the median
    lag between the feed's timestamp and our receipt of it is 12 seconds,
    which is ~130 m of road at racing speed.
    """
    if "body" in rec:
        try:
            payload = json.loads(rec["body"])
        except (json.JSONDecodeError, TypeError):
            return None, None
        if isinstance(payload, list) and payload:
            payload = payload[0]
        if not isinstance(payload, dict):
            return None, None
        ts = payload.get("TimeStamp")
        when = None
        if isinstance(ts, (int, float)) and _EPOCH_MIN < ts < _EPOCH_MAX:
            when = datetime.fromtimestamp(ts, tz=timezone.utc)
        elif rec.get("captured_at"):
            when = _parse_ts(rec["captured_at"])
        return when, payload.get("Riders")
    if "kmToFinish" in rec:
        # SSE rows carry `feed_ts`, the moment the position was measured. It
        # runs tens of seconds behind receipt (median 46s on stage 15, which is
        # ~500 m of road), so receipt time is only the fallback.
        ts = rec.get("feed_ts")
        if isinstance(ts, (int, float)) and _EPOCH_MIN < ts < _EPOCH_MAX:
            return datetime.fromtimestamp(ts, tz=timezone.utc), [rec]
        when = _parse_ts(rec["captured_at"]) if rec.get("captured_at") else None
        return when, [rec]
    return None, None


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
                when, riders = _sample_from_record(rec)
                if when is None or not riders:
                    continue
                km_to = _leader_km_to_finish(riders)
                if km_to is None:
                    continue
                samples.append((when, km_to))

    # A stale cached response repeats a payload we already have, so identical
    # (time, position) pairs collapse rather than being counted twice.
    samples = sorted(set(samples), key=lambda s: s[0])

    # Distance to the finish only ever decreases -- but "only ever decreases"
    # on its own is a trap. A single fix reporting half a kilometre too far up
    # the road is accepted, and then every correct sample behind it is thrown
    # away for going "backwards", so one bad reading biases the track forward
    # until the race catches up with it. So a jump also has to be physically
    # possible: faster than MAX_SPEED_KMH since the last accepted sample is a
    # bad fix, not a decrease.
    cleaned: list[tuple[datetime, float]] = []
    best = float("inf")
    last_ts = None
    for ts, km_to in samples:
        if km_to > best:
            continue
        if last_ts is not None:
            dt_h = (ts - last_ts).total_seconds() / 3600
            if dt_h > 0 and (best - km_to) / dt_h > MAX_SPEED_KMH:
                continue
        best, last_ts = km_to, ts
        cleaned.append((ts, km_to))
    return cleaned


def extend_track_to_start(track: list[tuple[datetime, float]],
                          route_length_km: float,
                          race_start: datetime | None):
    """Prepend a synthetic km-0 sample so the whole stage can be drawn.

    GPS often only comes online partway through (stage 14's first fix is 31 km
    in), which would otherwise truncate a third of the profile off the bar. The
    race's actual start time is known from the ticker, so the uncovered head can
    be spanned by interpolating between it and the first real fix.

    This is an estimate and is flagged as one: the leader's true pace over that
    stretch was not observed, only its average. Returns the extended track plus
    the km-to-finish above which points should be marked estimated.
    """
    if not track or race_start is None:
        return track, None
    first_ts, first_km_to = track[0]
    if first_km_to >= route_length_km - 0.05:
        return track, None                    # already covered from the gun
    if race_start >= first_ts:
        return track, None                    # start time is not before the fix
    return [(race_start, route_length_km)] + track, first_km_to


def sync_profile_to_time(profile: list[dict], track: list[tuple[datetime, float]],
                         max_gap_km: float = 2.0,
                         estimated_above_km_to: float | None = None) -> list[dict]:
    """Attach the leader's arrival time to each profile point.

    `track` descends in km-to-finish, so it is reversed into ascending order
    for bisection and each profile point is looked up by its own kmto value --
    no stage-length constant is involved anywhere.
    """
    if not track:
        return [dict(p, time_utc=None, interpolated=None, estimated=None) for p in profile]

    asc = sorted(track, key=lambda s: s[1])          # ascending km-to-finish
    kms = [km for _, km in asc]
    lo_km, hi_km = kms[0], kms[-1]

    out = []
    for point in profile:
        km_to = point["km_to_finish"]
        if km_to < lo_km or km_to > hi_km:
            out.append(dict(point, time_utc=None, interpolated=None, estimated=None))
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
        estimated = (estimated_above_km_to is not None
                     and km_to > estimated_above_km_to)
        out.append(dict(point,
                        time_utc=ts.isoformat(timespec="seconds"),
                        interpolated=interpolated,
                        estimated=estimated))
    return out


def build(stage_dir: Path, telemetry_paths, stage_length_km: float | None = None,
          race_start_utc: datetime | None = None) -> dict:
    """`stage_length_km` is accepted for reporting only; it is not used in the
    time mapping, which works purely in km-to-finish.

    `race_start_utc` lets the profile span the whole stage even when GPS came
    online late; the unobserved head is marked estimated rather than dropped.
    """
    profile = load_profile(stage_dir / "profile.csv")
    track = leader_track(telemetry_paths)
    route_len = max((p["km"] for p in profile), default=0)
    track, est_above = extend_track_to_start(track, route_len, race_start_utc)
    synced = sync_profile_to_time(profile, track, estimated_above_km_to=est_above)
    observed = [p for p in synced
                if p["time_utc"] and not p["interpolated"] and not p.get("estimated")]
    return {
        "stage_length_km": stage_length_km,
        "route_length_km": round(max((p["km"] for p in profile), default=0), 2),
        "profile_points": len(synced),
        "gps_samples": len(track),
        "observed_points": len(observed),
        "estimated_points": sum(1 for p in synced if p.get("estimated")),
        "timed_points": sum(1 for p in synced if p.get("time_utc")),
        "leader_first_seen": track[0][0].isoformat(timespec="seconds") if track else None,
        "leader_last_seen": track[-1][0].isoformat(timespec="seconds") if track else None,
        "leader_km_to_finish_range": [round(track[0][1], 2), round(track[-1][1], 2)] if track else None,
        "points": synced,
    }
