"""Persons of interest: the riders in contention for each jersey, per stage.

For a given stage we take the classification standings *entering* it (i.e. after
the previous stage) and keep:

    yellow  top 10 of the general classification
    green   top 10 of the points classification
    white   top 5 best-placed young riders

Sources, chosen for reliability:

* Yellow and white come from ASO's own race API (``rankingTypeArrival`` type
  ``itg`` -- the overall GC), which is tokenless and keyed by bib number, so no
  name-matching is needed. White is the GC filtered to riders young enough for
  the jersey (born on/after 1 Jan of year-25), which is exactly how the jersey
  is defined -- best young rider on GC.

* Green (points) is not exposed cleanly on the race API, so it is read from the
  official letour.fr classifications page, which embeds a signed AJAX URL per
  classification (``ipg`` = points). Riders there are identified by slug, which
  we map back to a bib by matching names against the roster.

A "person of interest" is any rider appearing in one of those three lists; the
same rider can hold more than one (e.g. a GC leader also high on points).
"""

from __future__ import annotations

import html
import json
import re
import unicodedata
from pathlib import Path

import requests

RACECENTER = "https://racecenter.letour.fr/api"
LETOUR = "https://www.letour.fr"
_HEADERS = {"User-Agent": "Mozilla/5.0 (tour-scraper persons-of-interest)"}
_TIMEOUT = 20

JERSEY_NAME = {"yellow": "GC", "green": "Points", "white": "Young"}


def _norm(s: str) -> str:
    """Lower-case, strip accents, collapse to single-spaced ascii words."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9]+", " ", s).lower().strip()
    return re.sub(r"\s+", " ", s)


def _tokens(s: str) -> frozenset:
    return frozenset(_norm(s).split())


def load_rider_index(year_dir: Path) -> dict:
    """bib -> rider facts, plus a token-set index for name matching."""
    riders = json.loads((year_dir / "reference" / "riders.json").read_text(encoding="utf-8"))
    idx: dict[int, dict] = {}
    by_tokens: dict[frozenset, int] = {}
    for r in riders:
        bib = r.get("bib")
        if bib is None:
            continue
        first, last = r.get("firstname") or "", r.get("lastname") or ""
        birth = r.get("birthdate")
        toks = _tokens(f"{first} {last}")
        idx[bib] = {
            "bib": bib,
            "name": f"{first.strip().title()} {last.strip().title()}".strip(),
            "last_norm": _norm(last),
            "tokens": toks,
            "birth_year": int(str(birth)[:4]) if birth else None,
        }
        by_tokens.setdefault(toks, bib)
    return {"by_bib": idx, "by_tokens": by_tokens}


def _get(url: str):
    return requests.get(url, headers=_HEADERS, timeout=_TIMEOUT)


def fetch_gc_order(prev_stage: int, year: int) -> list[int]:
    """Full general-classification order (bibs) after `prev_stage`."""
    data = _get(f"{RACECENTER}/rankingTypeArrival-{year}-{prev_stage}").json()
    for block in data:
        if block.get("type") == "itg":                    # individual time, general
            ranked = sorted(block.get("rankings", []),
                            key=lambda r: r.get("position") or 9999)
            return [r["bib"] for r in ranked if r.get("bib")]
    return []


def fetch_points_slugs(prev_stage: int, year: int) -> list[str]:
    """Points-classification order as rider slugs, from letour.fr."""
    page = _get(f"{LETOUR}/en/rankings/stage-{prev_stage}").text
    m = re.search(r"data-ajax-stack\s*=\s*(\{.*?\})", page)
    if not m:
        return []
    stack = json.loads(html.unescape(m.group(1)))
    ipg = stack.get("ipg")
    if not ipg:
        return []
    body = _get(LETOUR + ipg).text
    slugs, seen = [], set()
    for slug in re.findall(r"/en/rider/\d+/[^\"/]+/([a-z0-9\-]+)", body):
        if slug not in seen:
            seen.add(slug)
            slugs.append(slug)
    return slugs


def _match_slug(slug: str, riders: dict) -> int | None:
    """Map a letour slug (e.g. 'mads-pedersen') to a bib. Order-independent."""
    toks = _tokens(slug.replace("-", " "))
    bib = riders["by_tokens"].get(toks)
    if bib is not None:
        return bib
    flat = _norm(slug.replace("-", " ")).replace(" ", "")
    # Fall back to a surname match: the rider whose (multi-word) surname is a
    # run of tokens in the slug. Longest surname wins, to prefer "del toro" over
    # a bare "toro".
    best, best_len = None, 0
    for b, r in riders["by_bib"].items():
        ln = r["last_norm"].replace(" ", "")
        if ln and ln in flat and len(ln) > best_len:
            best, best_len = b, len(ln)
    return best


def _poi(riders: dict, bib: int, jersey: str, position: int) -> dict:
    r = riders["by_bib"].get(bib, {})
    return {"bib": bib, "name": r.get("name", f"#{bib}"),
            "jersey": jersey, "position": position}


def build(stage: int, year: int, year_dir: Path) -> dict:
    """Persons of interest for `stage`, from the standings entering it."""
    prev = stage - 1
    riders = load_rider_index(year_dir)
    out = {"stage": stage, "standings_after_stage": prev,
           "yellow": [], "green": [], "white": []}
    if prev < 1:
        out["note"] = "no standings before stage 1"
        return out

    gc = fetch_gc_order(prev, year)
    out["yellow"] = [_poi(riders, b, "yellow", i + 1) for i, b in enumerate(gc[:10])]

    cutoff = year - 25                                     # young-rider birth-year floor
    young = [b for b in gc
             if (riders["by_bib"].get(b, {}).get("birth_year") or 0) >= cutoff]
    out["white"] = [_poi(riders, b, "white", i + 1) for i, b in enumerate(young[:5])]

    green: list[int] = []
    for slug in fetch_points_slugs(prev, year):
        b = _match_slug(slug, riders)
        if b and b not in green:
            green.append(b)
        if len(green) >= 10:
            break
    out["green"] = [_poi(riders, b, "green", i + 1) for i, b in enumerate(green)]
    return out


# --------------------------------------------------------------- special markers

def person_directory(poi: dict) -> list[dict]:
    """One entry per person of interest, carrying every jersey they're in."""
    people: dict[int, dict] = {}
    for jersey in ("yellow", "green", "white"):
        for p in poi.get(jersey, []):
            e = people.setdefault(p["bib"], {"bib": p["bib"], "name": p["name"],
                                             "jerseys": [], "last_norm": _norm(
                                                 p["name"].split(" ", 1)[-1])})
            e["jerseys"].append({"jersey": jersey, "position": p["position"]})
    return list(people.values())


# The event kinds a rider is the ACTOR of, which is what a "POI x event" marker
# is about. History/stat/scenery items mention riders but aren't things a rider
# does, so they're excluded.
EVENT_CATEGORIES = {"crash", "breakaway_start", "breakaway_end"}
# How close a ticker mention has to be to a sprint/climb to count as "at" it.
_NEAR_SEC = 90


def _persons_payload(people: list[dict]) -> list[dict]:
    return [{"bib": p["bib"], "name": p["name"], "jerseys": p["jerseys"]} for p in people]


def special_markers(guideposts: list[dict], route_markers: list[dict],
                    poi: dict) -> list[dict]:
    """Event x person-of-interest markers.

    Two ways a person of interest attaches to an event:

    * A ticker event (attack / crash / caught) whose HEADLINE names them -- the
      headline is where the actor is, so "Pidcock pulls the break" tags Pidcock,
      while a rider merely listed in the body of some other item does not get a
      spurious marker.

    * A sprint or climb, tagged with any persons of interest the ticker names in
      its own headlines within a minute and a half of the point -- i.e. who was
      contesting it -- since the route marker itself carries no rider.

    Surnames are matched as whole words, longest first, so "van der poel" wins
    over a bare "poel".
    """
    from datetime import datetime

    people = sorted(person_directory(poi),
                    key=lambda p: len(p["last_norm"]), reverse=True)

    def named_in(text: str) -> list[dict]:
        t = _norm(text)
        return [p for p in people
                if p["last_norm"] and re.search(rf"\b{re.escape(p['last_norm'])}\b", t)]

    out = []
    for g in guideposts:
        if g.get("category") not in EVENT_CATEGORIES:
            continue
        named = named_in(g.get("label", ""))
        if named:
            out.append({"t_utc": g["t_utc"], "category": g["category"],
                        "label": g["label"], "persons": _persons_payload(named)})

    def _ts(x):
        try:
            return datetime.fromisoformat(x)
        except (TypeError, ValueError):
            return None

    stamped = [(g, _ts(g.get("t_utc"))) for g in guideposts]
    for m in route_markers or []:
        mt = _ts(m.get("t"))
        if mt is None:
            continue
        seen, named = set(), []
        for g, gt in stamped:
            if gt is None or abs((gt - mt).total_seconds()) > _NEAR_SEC:
                continue
            for p in named_in(g.get("label", "")):
                if p["bib"] not in seen:
                    seen.add(p["bib"])
                    named.append(p)
        if named:
            out.append({"t_utc": m["t"], "category": m["kind"],
                        "label": m["label"], "persons": _persons_payload(named)})

    out.sort(key=lambda x: x["t_utc"])
    return out
