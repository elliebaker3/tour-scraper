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

from . import gpx_profile
from .elevation_sync import build as build_sync
from .extract_events import build_guideposts, load_ticker
from .gpx_profile import altitude_at_km as gpx_alt_at_km
from .pcs_route import load_climbs
from .gpx_profile import load_stage as gpx_load
from .velowire_profile import name_route_markers


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


def actual_finish_utc(stage_dir: Path):
    """Time the stage was won, from the ticker's own finish marker.

    Independent of GPS, which matters when capture stops before the line: it
    is the anchor that lets the remaining route be spanned instead of dropped
    (see elevation_sync.extend_track_to_finish).

    This is a *publication* time, so it trails the actual crossing by however
    long the editor took -- fine for anchoring an explicitly estimated
    stretch, which is the only thing it is used for.
    """
    # The ticker does not always spell the finish the same way: stage 19 got
    # liv_finish, stage 20 only liv_winner_victory. Both mark the same moment,
    # so either will do -- and taking the EARLIEST of whichever appear keeps
    # the anchor as close to the actual crossing as the feed allows.
    seen = []
    for item in load_ticker(stage_dir):
        if item.get("picto") in ("liv_finish", "liv_winner_victory") and item.get("t"):
            try:
                seen.append(datetime.fromisoformat(item["t"]).astimezone(timezone.utc))
            except ValueError:
                continue
    return min(seen) if seen else None


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


def _interp_at_km(sync_points: list[dict], km: float) -> tuple[float | None, str | None]:
    """(altitude, time_utc) at a distance along the route, linearly
    interpolated from the already time-synced profile -- the same idea as
    gpx_profile.altitude_at_km, extended to time since this profile carries
    both. Used to place a PCS-sourced climb/sprint (km only, no altitude or
    time of its own) onto a full bundle's route_markers.
    """
    timed = [p for p in sync_points if p.get("time_utc") and p.get("altitude") is not None]
    if not timed:
        return None, None
    if km <= timed[0]["km"]:
        return timed[0]["altitude"], timed[0]["time_utc"]
    if km >= timed[-1]["km"]:
        return timed[-1]["altitude"], timed[-1]["time_utc"]
    lo, hi = 0, len(timed) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if timed[mid]["km"] <= km:
            lo = mid
        else:
            hi = mid
    a, b = timed[lo], timed[hi]
    span = b["km"] - a["km"]
    if span <= 0:
        return a["altitude"], a["time_utc"]
    frac = (km - a["km"]) / span
    alt = a["altitude"] + (b["altitude"] - a["altitude"]) * frac
    ta, tb = datetime.fromisoformat(a["time_utc"]), datetime.fromisoformat(b["time_utc"])
    t = (ta + (tb - ta) * frac).isoformat(timespec="seconds")
    return alt, t


# PCS's own category codes (pcs_route.TIER_TO_CAT) -> route_markers()'s
# formatted label. A different domain from _KOM_LABEL (ASO's raw "H"/"1".."4"
# column values) even though the categories are the same, so kept separate
# rather than reusing that dict with a mismatched key.
_PCS_CAT_LABEL = {"HC": "HC", "1": "Cat 1", "2": "Cat 2", "3": "Cat 3", "4": "Cat 4"}


def pcs_fallback_markers(year_dir: Path, stage_number: int,
                         sync_points: list[dict], length_km: float) -> list[dict]:
    """Climbs/sprints from pcs_route.py's scrape, converted into
    route_markers()'s shape and placed on the time axis via the profile
    that's already been time-synced against telemetry/groups.jsonl.

    Only meaningful when route_markers() itself came back empty, which
    happens whenever the base route shape came from a GPX track instead of
    ASO's profile.csv -- a GPX track carries no checkpoint/climb-category
    columns at all (see gpx_profile.as_route_points), so a stage synced that
    way has no ASO climb data to draw from. PCS only has this once a stage
    has actually been raced; one that hasn't yet just gets nothing here,
    same as before this existed.
    """
    pcs_climbs = load_climbs(year_dir).get(stage_number, [])
    out = []
    for m in pcs_climbs:
        km = m.get("km")
        name = (m.get("label") or "").strip()
        if km is None:
            continue
        alt, t = _interp_at_km(sync_points, km)
        # "name" is the real place name (PCS gives one directly, same field
        # velowire's name_route_markers() fills in for ASO markers); "label"
        # stays the generic grade description that field is reserved for
        # everywhere else in a bundle.
        common = {"km": round(km, 1), "kmto": round(length_km - km, 1),
                  "alt": round(alt) if alt is not None else None, "t": t,
                  **({"name": name} if name else {})}
        if m["kind"] == "sprint":
            out.append({**common, "kind": "sprint", "label": "Intermediate sprint"})
        else:
            cat_label = _PCS_CAT_LABEL.get(m.get("cat"), m.get("cat") or "")
            out.append({**common, "kind": "kom", "cat": cat_label,
                        "label": f"Climb — {cat_label}" if cat_label else "Climb",
                        "finish": km >= length_km - 0.5})
    return out


def _persons_of_interest(stage_number, year, year_dir, guideposts, markers,
                         racecenter=None, site=None):
    """Contenders per jersey + POI x event markers. Best-effort: this reaches
    the network (race API + the organiser's site), so a failure degrades to
    empty rather than breaking the whole bundle."""
    try:
        from . import persons_of_interest as poi_mod
        kwargs = {}
        if racecenter:
            kwargs["racecenter"] = racecenter
        if site:
            kwargs["site"] = site
        poi = poi_mod.build(stage_number, year, year_dir, **kwargs)
        specials = poi_mod.special_markers(guideposts, markers, poi)
        return poi, specials, None
    except Exception as e:                                   # network/parse/etc
        return None, [], str(e)


def publish_full_bundle(bundle: dict, stage_number: int, extension_data_dir: Path,
                        race: str = "tdf") -> str:
    """Publish a time-synced bundle to the extension as a "full" entry,
    superseding any "profile" (lite) placeholder for the same stage.

    Only meaningful once coverage.leader_track_source says the profile
    actually got a real clock -- e.g. from elevation_sync.build()'s
    groups.jsonl fallback for a stage with no individual GPS. Silently does
    nothing otherwise: publishing an all-null-time bundle as "full" would be
    WORSE than the lite fallback it would replace, since lite calibrates by
    km-interpolation and full expects a real per-point clock to fit
    calibration against.
    """
    if not bundle.get("coverage", {}).get("profile_points_observed"):
        return "not published (no observed points -- still time-unsynced)"

    extension_data_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"{race}-" if race and race != "tdf" else ""
    fname = f"{prefix}stage-{stage_number:02d}.json"
    (extension_data_dir / fname).write_text(
        json.dumps(bundle, ensure_ascii=False, separators=(",", ":")))

    index_path = extension_data_dir / "index.json"
    index = (json.loads(index_path.read_text(encoding="utf-8"))
             if index_path.exists() else {"schema": 1, "stages": []})
    meta = bundle.get("stage", {})
    dep, arr = meta.get("departure"), meta.get("arrival")
    entry = {
        "file": fname, "stage": stage_number, "date": meta.get("date"),
        "route": f"{dep} → {arr}" if dep and arr else None,
        "leader_first_utc": bundle["coverage"].get("leader_first_seen_utc"),
        "leader_last_utc": bundle["coverage"].get("leader_last_seen_utc"),
        "kind": "full",
    }
    if race and race != "tdf":
        entry["race"] = race

    others = [e for e in index["stages"]
             if (e.get("race", "tdf"), e["stage"]) != (race, stage_number)]
    index["stages"] = sorted([*others, entry], key=lambda e: e.get("date") or "")
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return f"published -> {extension_data_dir / fname}"


def publish_lite_guideposts(guideposts: list[dict], stage_number: int,
                            extension_data_dir: Path, race: str = "tdf") -> str:
    """Fallback for a stage with no time-synced track at all -- no individual
    telemetry and no groups.jsonl leader track either (see elevation_sync.
    build()'s fallback chain) -- so publish_full_bundle() has nothing to
    publish. A lite (profile-only) bundle has no clock to place most
    guideposts against, but one whose ticker text named its own km directly
    (KM_MENTION_RE in extract_events.py, e.g. "caught by the bunch at km
    16") can still be positioned with no telemetry needed at all. Merges
    just those into the lite bundle already published for this stage (by
    velowire/komoot's publish_lite_bundles); a no-op if that bundle hasn't
    been published yet or nothing here is placeable.
    """
    prefix = f"{race}-" if race and race != "tdf" else ""
    fname = f"{prefix}profile-stage-{stage_number:02d}.json"
    path = extension_data_dir / fname
    if not path.exists():
        return "lite guideposts not published (no lite bundle to merge into)"
    placeable = [g for g in guideposts if isinstance(g.get("km"), (int, float))]
    if not placeable:
        return "lite guideposts not published (no ticker item named its own km)"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["guideposts"] = placeable
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return f"published {len(placeable)} km-placed guidepost(s) -> {path}"


def build(stage_dir: Path, telemetry_paths, year_dir: Path,
          stage_number: int, out_path: Path | None = None,
          fetch_poi: bool = True, racecenter_base: str | None = None,
          site_base: str | None = None, extension_data_dir: Path | None = None,
          race: str = "tdf") -> Path:
    meta = stage_meta(year_dir, stage_number)
    length_km = float(meta.get("length_km") or 0) or None
    if not length_km:
        raise SystemExit(f"stage {stage_number}: no length in stages.json; run bootstrap first")

    # profile.csv is only ever written by a live poll session, off a
    # per-session hashed URL that can't be recovered after the fact (see
    # stage 2/7's gap). Losing profile.csv does NOT mean losing the ability
    # to time-sync, though -- that only needs a route SHAPE (km, altitude)
    # to place telemetry/groups.jsonl's leader track against, and a GPX
    # track (komoot's, for the Vuelta) supplies exactly that, just without
    # ASO's checkpoint/climb-category columns. Only when there is no route
    # shape AT ALL does this fall back to the ticker's own km mentions,
    # which need no track to place but only cover whichever guideposts
    # happened to name their own position in the text.
    have_profile_csv = (stage_dir / "profile.csv").exists()
    gpx_fallback_profile = None
    if not have_profile_csv:
        gpx = gpx_load(year_dir / "gpx", stage_number, length_km)
        if gpx and gpx["profile"] and not gpx.get("note"):
            gpx_fallback_profile = gpx_profile.as_route_points(gpx)

    if not have_profile_csv and not gpx_fallback_profile:
        events = build_guideposts(stage_dir, [])
        print(f"[navigator] stage {stage_number}: no profile.csv and no GPX track "
              f"-- ticker-only, no time-synced bundle")
        print(f"[navigator]   guideposts {events['counts']}")
        if extension_data_dir:
            print(f"[navigator]   {publish_lite_guideposts(events['guideposts'], stage_number, extension_data_dir, race)}")
        out_path = out_path or (stage_dir / "events_poi.json")
        out_path.write_text(json.dumps(events, ensure_ascii=False, separators=(",", ":")))
        return out_path

    # The real km-0 moment. The ticker tags it (liv_actual_start) and it can
    # differ from the schedule by minutes -- stage 14 rolled 5m38s late -- so
    # prefer it over stages.json for extending the profile to the start line.
    race_start = actual_start_utc(stage_dir) or scheduled_start_utc(meta)
    race_finish = actual_finish_utc(stage_dir)
    sync = build_sync(stage_dir, telemetry_paths, length_km,
                      race_start_utc=race_start, race_finish_utc=race_finish,
                      profile=gpx_fallback_profile)
    events = build_guideposts(stage_dir, sync["points"])

    if gpx_fallback_profile:
        # The GPX track itself already IS the profile sync ran against above
        # -- no ASO base to overlay altitude onto, and no checkpoint/climb
        # columns to keep either (see as_route_points). route_markers() will
        # come back empty; that is expected, not a bug, for a stage with no
        # ASO profile.csv at all.
        elevation_source = "gpx"
    else:
        # Terrain from the official GPX track, positions from ASO. The GPX is
        # the surveyed route -- denser than ASO's profile.csv and its own
        # distance lands within a few tenths of the official length -- but it
        # carries only track points: no km-to-finish column, no checkpoint
        # types, no climb grades. So each of ASO's points keeps its km, its
        # kmto, its checkpoint and its leader time, and only the ALTITUDE is
        # re-read from the GPX at that same distance. One source for shape,
        # one for structure, and the km scale stays ASO's throughout.
        elevation_source = "aso"
        gpx = gpx_load(year_dir / "gpx", stage_number, length_km)
        if gpx and gpx["profile"]:
            if gpx.get("note"):
                print(f"[navigator]   gpx: {gpx['note']} -- keeping ASO elevation")
            else:
                for p in sync["points"]:
                    alt = gpx_alt_at_km(gpx["profile"], p["km"])
                    if alt is not None:
                        p["altitude"] = alt
                elevation_source = "gpx"

    profile = [_slim(p) for p in downsample_profile(sync["points"])]
    markers = route_markers(sync["points"])
    # ASO places the climbs; velowire names them. Positions stay ASO's -- see
    # name_route_markers for why the two distance scales are not interchanged.
    markers, naming = name_route_markers(
        markers, year_dir / "profiles" / "velowire", stage_number)

    if not markers:
        # No ASO climb/checkpoint data at all (route_markers() draws from
        # sync["points"]' checkpoint_type/climb_category columns, which a
        # GPX-sourced profile never has -- see gpx_profile.as_route_points).
        # PCS's own scrape already carries real names, unlike ASO's generic
        # "Climb — Cat 1" (which needs velowire's separate naming pass), so
        # this skips straight past that step.
        markers = pcs_fallback_markers(year_dir, stage_number, sync["points"], length_km)
        naming = f"{len(markers)} from PCS (no ASO climb data)" if markers else naming

    year = int(year_dir.name) if year_dir.name.isdigit() else int(str(meta.get("date"))[:4])
    poi, specials, poi_err = (
        _persons_of_interest(stage_number, year, year_dir, events["guideposts"], markers,
                             racecenter=racecenter_base, site=site_base)
        if fetch_poi else (None, [], "skipped"))

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
            "race_finish_utc": race_finish.isoformat(timespec="seconds") if race_finish else None,
            "leader_first_seen_utc": sync["leader_first_seen"],
            "leader_last_seen_utc": sync["leader_last_seen"],
            "ticker_items": events["ticker_items"],
            "elevation_source": elevation_source,
            "leader_track_source": sync.get("leader_track_source"),
        },
        "profile": profile,
        "route_markers": markers,
        "guideposts": events["guideposts"],
        "intensity": events["intensity"],
        "persons_of_interest": poi,
        "special_markers": specials,
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
    print(f"[navigator]   route markers: {sprints} sprint(s), {koms} climb(s) · {naming}")
    if poi:
        print(f"[navigator]   persons of interest: {len(poi['yellow'])} yellow, "
              f"{len(poi['green'])} green, {len(poi['white'])} white · "
              f"{len(specials)} POI×event marker(s)")
    else:
        print(f"[navigator]   persons of interest: unavailable ({poi_err})")

    if extension_data_dir:
        print(f"[navigator]   {publish_full_bundle(bundle, stage_number, extension_data_dir, race)}")
        if not bundle["coverage"]["profile_points_observed"]:
            print(f"[navigator]   {publish_lite_guideposts(events['guideposts'], stage_number, extension_data_dir, race)}")

    return out_path
