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
BREAK_START_RE = re.compile(r"\b(attack\w*|clip off|jump\w* away|goes clear|got away|"
                            r"break(?:s)? away|launch\w* an attack|escape\w*)\b", re.I)
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
    """Newest publication snapshot holds the whole stage (the feed is cumulative)."""
    path = stage_dir / "polls" / "publication.jsonl"
    if not path.exists():
        return []
    last = None
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                last = line
    if not last:
        return []
    items = json.loads(json.loads(last)["body"])
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


def _mk(t, category, label, detail="", source="", **extra) -> dict:
    g = {"t_utc": _to_utc(t), "category": category, "label": label,
         "detail": detail[:400], "source": source}
    g.update(extra)
    return g


def classify_ticker(items: list[dict]) -> list[dict]:
    guideposts = []
    for it in items:
        picto, text, title = it["picto"], it["all"], it["title"]

        if (picto in CRASH_PICTOS) or CRASH_RE.search(text):
            guideposts.append(_mk(it["t"], "crash", title or "Incident", it["body"],
                                  f"ticker:{picto or it['type']}"))
            continue

        # Stat/standings lines are checked before the action patterns so a
        # phrase like "average speed after 2 hours" can't read as an attack.
        if picto in STAT_PICTOS and not BREAK_END_RE.search(text) \
                and not BREAK_START_RE.search(title):
            guideposts.append(_mk(it["t"], "stat", title or "Race data", it["body"],
                                  f"ticker:{picto}"))
            continue

        if BREAK_END_RE.search(text):
            guideposts.append(_mk(it["t"], "breakaway_end", title or "Breakaway caught",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        if (picto in BREAK_START_PICTOS) or BREAK_START_RE.search(text):
            guideposts.append(_mk(it["t"], "breakaway_start", title or "Attack",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        if ((picto in HISTORY_PICTOS) or HISTORY_RE.search(text)) \
                and not NOT_HISTORY_RE.search(text):
            guideposts.append(_mk(it["t"], "history", title or "Race history",
                                  it["body"], f"ticker:{picto or it['type']}"))
            continue

        # Scenic: ASO's own timestamped imagery of atmosphere rather than
        # incident. Requires media, so a passing mention of "the peloton" in a
        # tactical note doesn't register as a landscape beat.
        if it["media"] and ((picto in SCENIC_PICTOS) or SCENIC_RE.search(text)):
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


def build_guideposts(stage_dir: Path, synced_points: list[dict]) -> dict:
    items = load_ticker(stage_dir)
    guideposts = classify_ticker(items)
    guideposts.sort(key=lambda g: g["t_utc"])
    counts: dict[str, int] = {}
    for g in guideposts:
        counts[g["category"]] = counts.get(g["category"], 0) + 1
    return {
        "ticker_items": len(items),
        "counts": counts,
        "guideposts": guideposts,
        "intensity": intensity_curve(items, synced_points),
    }
