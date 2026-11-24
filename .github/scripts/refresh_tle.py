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
CELESTRAK_JSON = "https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=json"
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


# ---------- OMM (CelesTrak JSON) to TLE ----------
# Catalogue numbers ran past 99999 in 2026 and CelesTrak no longer serves newer
# objects as TLEs, so recent launches are fetched as OMM JSON and written back
# out as TLEs, using Alpha-5 for numbers of 100000 and up.
ALPHA5 = "ABCDEFGHJKLMNPQRSTUVWXYZ"   # A=10 ... Z=33 (no I or O)


def alpha5(n):
    n = int(n)
    if n < 100000:
        return f"{n:05d}"
    if n > 339999:
        raise ValueError(f"catalogue number {n} is beyond Alpha-5")
    return ALPHA5[n // 10000 - 10] + f"{n % 10000:04d}"


def tle_exp(x):
    """TLE 'assumed decimal point' exponent field, e.g. 0.00012345 -> ' 12345-3'."""
    x = float(x)
    if x == 0:
        return " 00000+0"
    sign = "-" if x < 0 else " "
    e = math.floor(math.log10(abs(x))) + 1
    digits = round(abs(x) / 10 ** e * 1e5)
    if digits >= 100000:
        digits //= 10
        e += 1
    if abs(e) > 9:
        return " 00000+0" if e < 0 else None
    return f"{sign}{digits:05d}{'-' if e < 0 else '+'}{abs(e)}"


def with_checksum(line68):
    total = sum(int(c) if c.isdigit() else (1 if c == "-" else 0) for c in line68)
    return line68 + str(total % 10)


def omm_to_tle(o):
    cat = alpha5(o["NORAD_CAT_ID"])
    cls = (o.get("CLASSIFICATION_TYPE") or "U")[:1]
    oid = o.get("OBJECT_ID") or ""
    intl = (oid[2:4] + oid[5:]) if len(oid) > 5 and oid[4] == "-" else ""
    t = dt.datetime.fromisoformat(o["EPOCH"].replace("Z", ""))
    doy = (t - dt.datetime(t.year, 1, 1)).total_seconds() / 86400 + 1
    epoch = f"{t.year % 100:02d}{doy:012.8f}"
    ndot = float(o.get("MEAN_MOTION_DOT", 0))
    ndot_s = ("-" if ndot < 0 else " ") + f"{abs(ndot):.8f}"[1:]
    nddot, bstar = tle_exp(o.get("MEAN_MOTION_DDOT", 0)), tle_exp(o.get("BSTAR", 0))
    if nddot is None or bstar is None or len(ndot_s) != 10:
        raise ValueError("value out of TLE range")
    elset = int(o.get("ELEMENT_SET_NO", 999)) % 10000
    l1 = f"1 {cat}{cls} {intl:<8} {epoch} {ndot_s} {nddot} {bstar} 0 {elset:>4}"
    ecc = f"{float(o['ECCENTRICITY']):.7f}"[2:]
    revs = int(o.get("REV_AT_EPOCH", 0)) % 100000
    l2 = (f"2 {cat} {float(o['INCLINATION']):8.4f} {float(o['RA_OF_ASC_NODE']):8.4f} {ecc} "
          f"{float(o['ARG_OF_PERICENTER']):8.4f} {float(o['MEAN_ANOMALY']):8.4f} "
          f"{float(o['MEAN_MOTION']):11.8f}{revs:5d}")
    if len(l1) != 68 or len(l2) != 68:
        raise ValueError("bad field width")
    return (o.get("OBJECT_NAME") or "NORAD " + str(o["NORAD_CAT_ID"])).strip(), with_checksum(l1), with_checksum(l2)


def parse_omm(text):
    out = []
    for o in json.loads(text):
        try:
            out.append(omm_to_tle(o))
        except (KeyError, ValueError, TypeError) as e:
            print(f"  skipped {o.get('OBJECT_NAME', '?')}: {e}")
    return [s for s in out if checksum_ok(s[1]) and checksum_ok(s[2])]


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
    f = sat[1][2:7]
    k = ALPHA5.find(f[0])
    return (k + 10) * 10000 + int(f[1:]) if k >= 0 else int(f)


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


def try_group(label, url, minimum=1, need=None, parser=parse):
    try:
        sats = parser(fetch(url))
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
    for label, url, parser in (("CelesTrak", CELESTRAK_JSON.format(group="last-30-days"), parse_omm),
                               ("mirror", MIRROR.format(group="last-30-days"), parse)):
        sats = try_group(label, url, parser=parser)
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
