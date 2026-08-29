"""Turn captured stage data into timestamped Navigator guideposts.

This is workflow item (2): identify the moments worth putting on a recording's
scrub bar. Every guidepost carries a UTC timestamp, so a two-point anchor can
map it onto any recording of the same stage.

Categories and where each actually comes from
---------------------------------------------
crash        Ticker items whose picto/text indicate a fall, withdrawal or
             mechanical. ASO tags these (liv_pack_drops_rider, liv_withdrawals,
             liv_mach_prob, liv_bike_change), so this is mostly tag-driven with
             a keyword net for untagged phrasings.

breakaway    Start and end are treated as distinct events. Starts come from
             attack/breakaway tags; ends from "caught / reeled in / brought
             back" phrasing. Where GPS exists we corroborate with the gap
             between the leader and the main group, which rises as a move
             sticks and collapses when it is absorbed.

scenic       The world feed is universal, so rather than guess at commentary
             we use what ASO themselves published against the clock: their
             timestamped photo and video posts (imageLangs / videoLangs) whose
             subject is the peloton, the crowd or the landscape rather than a
             race incident. Summit crossings are added positionally, because a
             director cuts to the panorama at a col essentially every time.

history      Ticker items referencing a year, an edition or a record, plus the
             stage-town heritage text carried in stages.json, positioned at the
             town's own checkpoint.

intensity    Computed from race data instead of audio: a rolling score over
             ticker-event density, leader speed variance and road gradient.
             Peaks mark "something is happening", which is the signal a louder
             commentator would otherwise have given us.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

TAG_RE = re.compile(r"<[^>]+>")

CRASH_PICTOS = {"liv_pack_drops_rider", "liv_withdrawals", "liv_mach_prob", "liv_bike_change"}
CRASH_RE = re.compile(r"\b(crash|crashe[sd]|fell|fall|falls|came down|hit the deck|"
                      r"abandon\w*|withdraw\w*|puncture\w*|mechanical)\b", re.I)

BREAK_START_PICTOS = {"liv_attack", "liv_breakaway"}
BREAK_START_RE = re.compile(r"\b(attacks?|attacked|attacking|clip off|jump\w* away|"
                            r"goes clear|got away|break(?:s)? away|breaks clear|"
                            r"launch\w* an attack|escap(?:e|es|ed|ing))\b", re.I)
BREAK_END_RE = re.compile(r"\b(caught|catch(?:es|ing)?|reeled in|brought back|"
                          r"swallowed up|absorbed|has been caught|neutralis\w*|"
                          r"back together|regroup\w*)\b", re.I)

SCENIC_PICTOS = {"liv_sun", "liv_rain"}
SCENIC_RE = re.compile(r"\b(landscape|scenery|panorama|view|crowd|spectators|"
                       r"ch[aâ]teau|castle|abbey|vineyard|lake|village|peloton)\b", re.I)

HISTORY_PICTOS = {"liv_story", "liv_statistics"}
# Anniversary/birthday items match year-like patterns but are not race history.
NOT_HISTORY_RE = re.compile(r"\b(happy birthday|birthday|anniversary)\b", re.I)
STAT_PICTOS = {"liv_speed", "liv_statistics", "liv_team_ranking",
               "liv_top_1", "liv_top_2", "liv_top_5", "liv_gap"}
HISTORY_RE = re.compile(r"\b(19\d{2}|20[0-2]\d|first time|for the first|history|historic\w*|"
                        r"record|legendary|edition|since \d{4})\b", re.I)

# Matches "at km 19", "km 16", "(cat. 1, km 25.1)" -- the ticker naming its
# own position directly, which is the only way to place an event on a stage
# that never captured telemetry OR groups.jsonl (so has no distance-over-time
# track of any kind to sync against otherwise -- see elevation_sync.py).
# Deliberately km-THEN-number only: a digit-before-km form ("45 km/h", "9.4
# km stage", "first 5.6km") reads as a speed or a stage-length aside far more
# often than a position, and would false-positive constantly.
KM_MENTION_RE = re.compile(r"\bkm\s+(\d+(?:\.\d+)?)\b", re.I)


def _extract_km(text: str) -> float | None:
    m = KM_MENTION_RE.search(text or "")
    return float(m.group(1)) if m else None


def _clean(text: str) -> str:
    return " ".join(TAG_RE.sub(" ", text or "").split())


def _item_text(item: dict) -> str:
    parts = [item.get("title") or ""]
    parts += item.get("text") or []
    if item.get("legend"):
        parts.append(item["legend"])
    for lang in item.get("socialContentLangs") or []:
        parts.append(lang.get("title") or "")
    return _clean(" ".join(parts))


def _has_media(item: dict) -> bool:
    return bool(item.get("imageLangs") or item.get("videoLangs")
                or item.get("url") or item.get("image"))


def load_ticker(stage_dir: Path) -> list[dict]:
    """Newest publication snapshot holds the whole stage (the feed is cumulative).

    A chunked capture (scrape-chunk.yml's --part) writes polls/publication.
    part-N.jsonl per chunk instead of one polls/publication.jsonl -- glob for
    both rather than only the un-chunked name, and take the snapshot with the
    latest captured_at across every part (each is individually cumulative, so
    that one is simply the most complete)."""
    paths = sorted(stage_dir.glob("polls/publication*.jsonl"))
    if not paths:
        return []
    last = None
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                rec = json.loads(line)
                if last is None or rec.get("captured_at", "") > last.get("captured_at", ""):
                    last = rec
    if not last:
        return []
    items = json.loads(last["body"])
    out = []
    for it in items:
        pub = it.get("publicationAt")
        if not pub:
            continue
        out.append({
            "t": pub,
            "title": _clean(it.get("title") or ""),
            "body": _clean(" ".join(it.get("text") or [])),
            "all": _item_text(it),
            "picto": it.get("picto"),
            "type": it.get("type"),
            "media": _has_media(it),
            "id": it.get("id"),
        })
    out.sort(key=lambda x: x["t"])
    return out


def _to_utc(text: str) -> str:
    """ISO string -> UTC ISO string. The ticker uses race-local time (+02:00),
    GPS-derived times are already UTC; everything downstream assumes UTC."""
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _titled(title: str, rx) -> bool:
    """Whether the headline settles this question on its own."""
    return bool(title and rx.search(title))


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _mk(t, category, label, detail="", source="", **extra) -> dict:
    g = {"t_utc": _to_utc(t), "category": category, "label": label,
         "detail": detail[:400], "source": source,
         # Sources read "ticker:liv_attack" for a pictogram item and
         # "ticker:<type>" for a plain headline, which is what dedupe_streams
         # keys on. (A cleverer expression here got it backwards and marked
         # everything a headline, silently disabling the dedupe.)
         "picto": str(source).startswith("ticker:liv_")}
    km = _extract_km(f"{label} {detail}")
    if km is not None:
        g["km"] = km
    g.update(extra)
    return g


def classify_ticker(items: list[dict]) -> list[dict]:
    guideposts = []
    for it in items:
        picto, text, title = it["picto"], it["all"], it["title"]
        # hit(RE): the title's verdict if it has one, else the body's.
        def hit(rx, _t=title, _x=text):
            return rx.search(_t) or (not _titled(_t, rx) and rx.search(_x))

        if (picto in CRASH_PICTOS) or hit(CRASH_RE):
            guideposts.append(_mk(it["t"], "crash", title or "Incident", it["body"],
                                  f"ticker:{picto or it['type']}"))
            continue

        # Stat/standings lines are checked before the action patterns so a
        # phrase like "average speed after 2 hours" can't read as an attack.
        if picto in STAT_PICTOS and not hit(BREAK_END_RE) \
                and not hit(BREAK_START_RE):
            guideposts.append(_mk(it["t"], "stat", title or "Race data", it["body"],
                                  f"ticker:{picto}"))
            continue

        if hit(BREAK_END_RE):
            guideposts.append(_mk(it["t"], "breakaway_end", title or "Breakaway caught",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        if (picto in BREAK_START_PICTOS) or hit(BREAK_START_RE):
            guideposts.append(_mk(it["t"], "breakaway_start", title or "Attack",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        if ((picto in HISTORY_PICTOS) or hit(HISTORY_RE)) \
                and not hit(NOT_HISTORY_RE):
            guideposts.append(_mk(it["t"], "history", title or "Race history",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        # Scenic: ASO's own timestamped imagery of atmosphere rather than
        # incident. Requires media, so a passing mention of "the peloton" in a
        # tactical note doesn't register as a landscape beat.
        if it["media"] and ((picto in SCENIC_PICTOS) or hit(SCENIC_RE)):
            guideposts.append(_mk(it["t"], "scenic", title or "Race imagery",
                                  it["body"], f"aso-media:{it['type'] or 'photo'}"))
    return guideposts


# Sprints and categorized climbs used to be emitted here as scenic/route
# guideposts. They now have their own first-class channel -- route_markers in
# build_bundle, straight from ASO's route data -- which is exact, carries the
# climb category, and is drawn on the elevation curve. Keeping them here too
# would double-mark every summit, so this step is gone.


def intensity_curve(items: list[dict], synced_points: list[dict],
                    window_min: int = 5) -> list[dict]:
    """Rolling excitement score, standing in for commentary loudness.

    Combines how densely the ticker is firing with how steep the road is --
    both rise exactly when a broadcast gets animated. Returned as a series the
    Navigator can draw as a heat strip under the elevation profile.
    """
    stamped = [datetime.fromisoformat(_to_utc(i["t"])) for i in items if i.get("t")]
    if not stamped:
        return []
    start, end = min(stamped), max(stamped)

    grade_at = []
    for p in synced_points:
        if p.get("time_utc") and p.get("slope") is not None:
            grade_at.append((datetime.fromisoformat(_to_utc(p["time_utc"])), abs(p["slope"])))
    grade_at.sort(key=lambda x: x[0])

    series = []
    step = timedelta(minutes=window_min)
    cursor = start
    while cursor <= end:
        upper = cursor + step
        n_events = sum(1 for t in stamped if cursor <= t < upper)
        grades = [g for t, g in grade_at if cursor <= t < upper]
        mean_grade = sum(grades) / len(grades) if grades else 0.0
        # Event density dominates; gradient is a supporting term.
        score = n_events + min(mean_grade, 12.0) / 4.0
        series.append({
            "t_utc": cursor.isoformat(timespec="seconds"),
            "window_min": window_min,
            "events": n_events,
            "mean_abs_grade": round(mean_grade, 2),
            "score": round(score, 2),
        })
        cursor = upper

    peak = max((s["score"] for s in series), default=0) or 1
    for s in series:
        s["normalised"] = round(s["score"] / peak, 3)
    return series


# ASO publishes the same moment twice: a pictogram item with detail, then a
# plain headline restating it a minute or three later. On stage 20 that put two
# markers on Carapaz's Croix de Fer attack and two on Pedersen's, inside four
# minutes of each other.
DUPLICATE_WINDOW_SEC = 300


def dedupe_streams(guideposts: list[dict]) -> list[dict]:
    """Drop a plain headline that merely restates a nearby pictogram item.

    The two are distinguishable structurally rather than by comparing wording:
    a pictogram item carries a picto and usually body detail, a plain headline
    carries neither. So where both describe the same KIND of moment within a
    few minutes, the pictogram one is kept -- it is the richer record, with the
    detail line the panel shows.

    Restricted to the same category deliberately. Nearly every plain headline
    is within five minutes of SOME pictogram item simply because there are 91
    of them across a stage; only a same-category collision is evidence of a
    restatement rather than a coincidence. Two genuine attacks minutes apart
    both carry pictos, so neither is ever dropped by this.
    """
    picto_by_cat: dict[str, list] = {}
    for g in guideposts:
        if g.get("picto"):
            picto_by_cat.setdefault(g["category"], []).append(_parse_ts(g["t_utc"]))

    kept = []
    for g in guideposts:
        if not g.get("picto"):
            t = _parse_ts(g["t_utc"])
            near = any(abs((t - o).total_seconds()) <= DUPLICATE_WINDOW_SEC
                       for o in picto_by_cat.get(g["category"], []))
            if near:
                continue
        kept.append(g)
    return kept


def build_guideposts(stage_dir: Path, synced_points: list[dict]) -> dict:
    items = load_ticker(stage_dir)
    guideposts = classify_ticker(items)
    before = len(guideposts)
    guideposts = dedupe_streams(guideposts)
    guideposts.sort(key=lambda g: g["t_utc"])
    counts: dict[str, int] = {}
    for g in guideposts:
        counts[g["category"]] = counts.get(g["category"], 0) + 1
    return {
        "ticker_items": len(items),
        "duplicates_dropped": before - len(guideposts),
        "counts": counts,
        "guideposts": guideposts,
        "intensity": intensity_curve(items, synced_points),
    }
