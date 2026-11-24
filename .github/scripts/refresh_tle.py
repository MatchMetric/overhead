#!/usr/bin/env python3
"""Refresh data/tle.json for Overhead.

Fetches the CelesTrak "visual" (brightest) group, with the caelo-works GitHub
mirror as a fallback and as a cross-check for the ISS and Tiangong. Recent
launches come from CelesTrak's last-30-days group. Every TLE line is checksum
verified. If nothing newer and valid can be fetched, the existing file is left
untouched, so the site never ends up with broken or empty satellite data.

Usage: refresh_tle.py data/tle.json
"""
import datetime as dt
import json
import math
import sys
import urllib.request

from sgp4.api import Satrec, jday

CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle"
MIRROR = "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/{group}.tle"
MIRROR_UPDATED = "https://raw.githubusercontent.com/caelo-works/tle-mirror/main/tle/updated.txt"
HEADERS = {"User-Agent": "Overhead sky app daily refresh (github.com/MatchMetric/overhead)"}
ISS, TIANGONG = 25544, 48274
MIN_VISUAL = 100      # a healthy visual group has ~150 objects
RECENT_MAX = 40       # keep the newest launches only, so the page stays quick
RECENT_DAYS = 30


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def checksum_ok(line):
    if len(line) < 69 or not line[68].isdigit():
        return False
    total = sum(int(c) if c.isdigit() else (1 if c == "-" else 0) for c in line[:68])
    return total % 10 == int(line[68])


def parse(text):
    """Return [(name, line1, line2)] for every complete, checksum-valid element set."""
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    out = []
    for i in range(len(lines) - 1):
        l1, l2 = lines[i], lines[i + 1]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            continue
        if l1[2:7] != l2[2:7] or not (checksum_ok(l1) and checksum_ok(l2)):
            continue
        name = lines[i - 1].strip() if i > 0 and not lines[i - 1][:2] in ("1 ", "2 ") else "NORAD " + l1[2:7].strip()
        out.append((name, l1, l2))
    return out


def norad(sat):
    return int(sat[1][2:7])


def epoch(sat):
    l1 = sat[1]
    yy, doy = int(l1[18:20]), float(l1[20:32])
    year = 2000 + yy if yy < 57 else 1900 + yy
    return dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=doy - 1)


def launch_key(sat):
    """International designator as a sortable (year, launch number) pair, e.g. 26159A -> (2026, 159)."""
    d = sat[1][9:14]
    try:
        yy, num = int(d[:2]), int(d[2:5])
    except ValueError:
        return (0, 0)
    return (2000 + yy if yy < 57 else 1900 + yy, num)


def position_km(sat, when):
    s = Satrec.twoline2rv(sat[1], sat[2])
    jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute,
                  when.second + when.microsecond / 1e6)
    err, r, _ = s.sgp4(jd, fr)
    return None if err else r


def km_apart(a, b, when):
    ra, rb = position_km(a, when), position_km(b, when)
    if ra is None or rb is None:
        return None
    return round(math.dist(ra, rb), 3)


def to_text(sats):
    return "\n".join(f"{n}\n{l1}\n{l2}" for n, l1, l2 in sats) + "\n"


def try_group(label, url, minimum=1, need=None):
    try:
        sats = parse(fetch(url))
    except Exception as e:  # network errors, HTTP errors, rate limits
        print(f"  {label}: fetch failed ({e})")
        return None
    ids = {norad(s) for s in sats}
    if len(sats) < minimum or (need and need not in ids):
        print(f"  {label}: unusable ({len(sats)} valid element sets)")
        return None
    print(f"  {label}: {len(sats)} valid element sets")
    return sats


def main(path):
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    with open(path, encoding="utf-8") as f:
        old = json.load(f)
    old_iss = next((s for s in parse(old.get("tle", "")) if norad(s) == ISS), None)

    print("Brightest satellites:")
    sources = {}
    for label, url in (("CelesTrak", CELESTRAK.format(group="visual")),
                       ("mirror", MIRROR.format(group="visual"))):
        sats = try_group(label, url, MIN_VISUAL, ISS)
        if sats:
            sources[label] = sats
    if not sources:
        print("No usable source today; keeping the existing data.")
        return

    def iss_of(sats):
        return next(s for s in sats if norad(s) == ISS)

    primary = max(sources, key=lambda k: epoch(iss_of(sources[k])))
    visual = sources[primary]
    if old_iss and epoch(iss_of(visual)) <= epoch(old_iss):
        print("Nothing newer than the data already on the site; keeping it.")
        return
    print(f"Using {primary} (ISS elements from {epoch(iss_of(visual)):%Y-%m-%d %H:%M} UTC)")

    cross = {}
    other = next((k for k in sources if k != primary), None)
    if other:
        a = {norad(s): s for s in visual}
        b = {norad(s): s for s in sources[other]}
        for sid in (ISS, TIANGONG):
            if sid in a and sid in b:
                km = km_apart(a[sid], b[sid], now)
                if km is not None:
                    cross[str(sid)] = km
        print(f"Cross-check against {other}: {cross}")

    if primary == "CelesTrak":
        source = 'CelesTrak "brightest" (visual) group, fetched daily, line checksums verified'
        updated = now
    else:
        source = 'CelesTrak "brightest" (visual) group via github.com/caelo-works/tle-mirror, line checksums verified'
        try:
            updated = dt.datetime.fromisoformat(fetch(MIRROR_UPDATED).strip().replace("Z", "+00:00"))
        except Exception:
            updated = now

    print("Recent launches:")
    recent = None
    for label, url in (("CelesTrak", CELESTRAK.format(group="last-30-days")),
                       ("mirror", MIRROR.format(group="last-30-days"))):
        sats = try_group(label, url)
        if sats and max(epoch(s) for s in sats) > now - dt.timedelta(days=RECENT_DAYS):
            recent = sats
            break
        if sats:
            print(f"  {label}: older than {RECENT_DAYS} days, skipped")
    if recent:
        recent.sort(key=lambda s: (launch_key(s), s[1][14:17]), reverse=True)
        recent = recent[:RECENT_MAX]
        recent.sort(key=norad)
        print(f"  keeping the newest {len(recent)}")
    else:
        recent = parse(old.get("recent", ""))
        print(f"  none available; keeping the previous {len(recent)}")

    out = {
        "source": source,
        "mirrorUpdated": updated.isoformat().replace("+00:00", "Z"),
        "built": now.isoformat().replace("+00:00", "Z"),
        "count": len(visual),
        "crossCheckKm": cross,
        "tle": to_text(visual),
        "recent": to_text(recent) if recent else "",
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Wrote {path}: {len(visual)} bright satellites, {len(recent)} recent launches.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/tle.json")
