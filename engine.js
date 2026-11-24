/* Sky engine: satellite passes (SGP4 via satellite.js) and Sun/Moon/planets (astronomy-engine).
   Runs unchanged in the browser and in Node (tests). Times are JS Dates (UTC internally). */
(function (root) {
  'use strict';
  const S = root.satellite, A = root.Astronomy;
  const DEG = Math.PI / 180, RE = 6378.137, AU_KM = 149597870.7;

  // ---------- TLE parsing with checksum validation ----------
  function tleChecksumOK(line) {
    if (line.length < 69) return false;
    let s = 0;
    for (let i = 0; i < 68; i++) { const c = line[i]; if (c >= '0' && c <= '9') s += +c; else if (c === '-') s += 1; }
    return (s % 10) === +line[68];
  }
  function tleEpoch(l1) {
    const yy = +l1.slice(18, 20), doy = parseFloat(l1.slice(20, 32));
    const y = yy < 57 ? 2000 + yy : 1900 + yy;
    return new Date(Date.UTC(y, 0, 1) + (doy - 1) * 86400000);
  }
  // Catalogue number from columns 3-7. Numbers from 100000 up use Alpha-5: a letter (A=10 ... Z=33, no I or O) for the first two digits.
  function catNum(field) {
    const k = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.indexOf(field.charAt(0));
    return k >= 0 ? (k + 10) * 10000 + +field.slice(1) : +field;
  }
  function parseTLE(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.length);
    const out = [], bad = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('1 ') && lines[i + 1] && lines[i + 1].startsWith('2 ')) {
        const name = (i > 0 && !/^[12] /.test(lines[i - 1])) ? lines[i - 1].trim() : 'NORAD ' + lines[i].slice(2, 7).trim();
        const l1 = lines[i], l2 = lines[i + 1];
        const id = catNum(l1.slice(2, 7));
        if (!tleChecksumOK(l1) || !tleChecksumOK(l2) || catNum(l2.slice(2, 7)) !== id) { bad.push(name); i++; continue; }
        const rec = S.twoline2satrec(l1, l2);
        if (rec.error) { bad.push(name); i++; continue; }
        out.push({ name, id, l1, l2, epoch: tleEpoch(l1), rec, incl: +l2.slice(8, 16), revPerDay: +l2.slice(52, 63) });
        i++;
      }
    }
    return { sats: out, bad };
  }

  // ---------- Observer ----------
  function observer(lat, lon, heightM) {
    const gd = { latitude: lat * DEG, longitude: lon * DEG, height: (heightM || 0) / 1000 };
    // aobs0 (sea level) is used for rise/set so times follow the almanac convention (standard 34' refraction)
    return { lat, lon, heightM: heightM || 0, gd, ecf: S.geodeticToEcf(gd), aobs: new A.Observer(lat, lon, heightM || 0), aobs0: new A.Observer(lat, lon, 0) };
  }

  // ---------- Sun: exact values on a 60 s grid, linearly interpolated between nodes ----------
  const GRID = 60000, sunCache = new Map(), sunAltCache = new Map();
  function sunNode(k) {              // km, equator & equinox of date (~TEME)
    let v = sunCache.get(k);
    if (!v) {
      const t = A.MakeTime(new Date(k * GRID));
      const g = A.RotateVector(A.Rotation_EQJ_EQD(t), A.GeoVector(A.Body.Sun, t, true));
      v = { x: g.x * AU_KM, y: g.y * AU_KM, z: g.z * AU_KM };
      if (sunCache.size > 100000) sunCache.clear();
      sunCache.set(k, v);
    }
    return v;
  }
  function sunEci(date) {
    const x = date.getTime() / GRID, k = Math.floor(x), f = x - k, a = sunNode(k), b = sunNode(k + 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  }
  function sunAltNode(obs, k) {      // degrees, geometric (no refraction)
    const key = obs.lat + ',' + obs.lon + ',' + obs.heightM + ',' + k;
    let v = sunAltCache.get(key);
    if (v === undefined) {
      const d = new Date(k * GRID), eq = A.Equator(A.Body.Sun, d, obs.aobs, true, true);
      v = A.Horizon(d, obs.aobs, eq.ra, eq.dec, null).altitude;
      if (sunAltCache.size > 100000) sunAltCache.clear();
      sunAltCache.set(key, v);
    }
    return v;
  }
  function sunAlt(obs, date) {
    const x = date.getTime() / GRID, k = Math.floor(x), f = x - k;
    const a = sunAltNode(obs, k), b = sunAltNode(obs, k + 1);
    return a + (b - a) * f;
  }

  // ---------- Satellite state ----------
  // Sunlit test: is the straight line from satellite to the Sun's centre clear of the Earth (sphere R=6378.137 km)?
  function isSunlit(r, sun) {
    const dx = sun.x - r.x, dy = sun.y - r.y, dz = sun.z - r.z;
    const dd = dx * dx + dy * dy + dz * dz;
    const t = -(r.x * dx + r.y * dy + r.z * dz) / dd;
    if (t <= 0) return true;
    const px = r.x + t * dx, py = r.y + t * dy, pz = r.z + t * dz;
    return (px * px + py * py + pz * pz) > RE * RE;
  }
  function state(sat, obs, date) {
    const pv = S.propagate(sat.rec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    const r = pv.position, gmst = S.gstime(date);
    const la = S.ecfToLookAngles(obs.gd, S.eciToEcf(r, gmst));
    return { r, gmst, az: la.azimuth / DEG, el: la.elevation / DEG, range: la.rangeSat };
  }
  // Brightness: McCants' formula with a standard magnitude (1000 km range, 50% illuminated).
  function magnitude(stdMag, sat, obs, date, st) {
    if (stdMag == null) return null;
    st = st || state(sat, obs, date); if (!st) return null;
    const sun = sunEci(date), o = S.ecfToEci(obs.ecf, st.gmst), r = st.r;
    const a = { x: sun.x - r.x, y: sun.y - r.y, z: sun.z - r.z }, b = { x: o.x - r.x, y: o.y - r.y, z: o.z - r.z };
    const cosp = (a.x * b.x + a.y * b.y + a.z * b.z) / Math.hypot(a.x, a.y, a.z) / Math.hypot(b.x, b.y, b.z);
    const fracil = Math.max(1e-6, (1 + cosp) / 2);
    return stdMag - 15.75 + 2.5 * Math.log10(st.range * st.range / fracil);
  }
  function geodetic(sat, date) {
    const pv = S.propagate(sat.rec, date); if (!pv || !pv.position) return null;
    const g = S.eciToGeodetic(pv.position, S.gstime(date));
    return { lat: g.latitude / DEG, lon: S.degreesLong(g.longitude), height: g.height };
  }

  // ---------- Pass search ----------
  function bisect(f, a, b, fa, iters) {      // root of boolean change between a and b (ms)
    for (let i = 0; i < (iters || 14); i++) { const m = (a + b) / 2; if (f(m) === fa) a = m; else b = m; }
    return (a + b) / 2;
  }
  function elAt(sat, obs, ms) { const s = state(sat, obs, new Date(ms)); return s ? s.el : -90; }
  function visibleAt(sat, obs, ms, opt) {
    const d = new Date(ms), s = state(sat, obs, d);
    if (!s || s.el < opt.minEl) return false;
    return sunAlt(obs, d) <= opt.sunMax && isSunlit(s.r, sunEci(d));
  }
  /* Returns passes above opt.minEl between t0 and t1 (Dates). Each pass has rise/culm/set and,
     if any part is visible (satellite sunlit, observer Sun altitude <= opt.sunMax), vis {start, max, end, mag}. */
  function passes(sat, obs, t0, t1, opt) {
    opt = Object.assign({ minEl: 10, sunMax: -6, step: 20000, stdMag: null, visibleOnly: false }, opt || {});
    const out = [], a = t0.getTime(), b = t1.getTime(), step = opt.step;
    let prevMs = a, prevUp = elAt(sat, obs, a) >= opt.minEl, riseMs = prevUp ? a : null;
    for (let ms = a + step; ms <= b + step; ms += step) {
      const tms = Math.min(ms, b), up = elAt(sat, obs, tms) >= opt.minEl;
      if (up !== prevUp) {
        const edge = bisect(x => elAt(sat, obs, x) >= opt.minEl, prevMs, tms, prevUp);
        if (up) riseMs = edge; else if (riseMs !== null) { const p = finishPass(sat, obs, riseMs, edge, opt); if (p) out.push(p); riseMs = null; }
      }
      prevUp = up; prevMs = tms;
      if (tms >= b) break;
    }
    if (riseMs !== null && prevUp) { const p = finishPass(sat, obs, riseMs, b, opt, true); if (p) out.push(p); }
    return out;
  }
  function culminate(f, lo, hi) {             // golden-section maximum of f on [lo, hi]
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = f(x1), f2 = f(x2);
    while (hi - lo > 200) {
      if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = f(x2); }
      else { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = f(x1); }
    }
    return (lo + hi) / 2;
  }
  function point(sat, obs, ms, opt) {
    const d = new Date(ms), s = state(sat, obs, d);
    return { t: d, az: s.az, el: s.el, range: s.range, sunlit: isSunlit(s.r, sunEci(d)), sunAlt: sunAlt(obs, d),
      mag: magnitude(opt.stdMag, sat, obs, d, s) };
  }
  function finishPass(sat, obs, riseMs, setMs, opt, truncated) {
    const culmMs = culminate(x => elAt(sat, obs, x), riseMs, setMs);
    const pass = { sat, rise: point(sat, obs, riseMs, opt), culm: point(sat, obs, culmMs, opt), set: point(sat, obs, setMs, opt), truncated: !!truncated };
    // visible window: scan at 2 s, refine edges by bisection
    const f = x => visibleAt(sat, obs, x, opt);
    let vs = null, ve = null, prev = f(riseMs), prevX = riseMs;
    if (prev) vs = riseMs;
    for (let x = riseMs + 2000; ; x += 2000) {
      const xx = Math.min(x, setMs), v = f(xx);
      if (v !== prev) { const e = bisect(f, prevX, xx, prev, 12); if (v) { if (vs === null) vs = e; } else ve = e; }
      if (v) ve = null;
      prev = v; prevX = xx;
      if (xx >= setMs) break;
    }
    if (vs !== null) {
      if (ve === null) ve = setMs;
      let maxMs = (culmMs >= vs && culmMs <= ve) ? culmMs : (elAt(sat, obs, vs) >= elAt(sat, obs, ve) ? vs : ve);
      let best = null;                       // brightest magnitude during the visible part
      if (opt.stdMag != null) for (let x = vs; x <= ve; x += 4000) { const m = magnitude(opt.stdMag, sat, obs, new Date(x)); if (m != null && (best === null || m < best)) best = m; }
      pass.vis = { start: point(sat, obs, vs, opt), max: point(sat, obs, maxMs, opt), end: point(sat, obs, ve, opt), mag: best };
    } else if (opt.visibleOnly) return null;
    return pass;
  }
  function track(sat, obs, t0, t1, stepMs) {   // az/el samples for drawing a pass
    const out = [];
    for (let ms = t0.getTime(); ms <= t1.getTime() + 1; ms += stepMs || 5000) {
      const d = new Date(Math.min(ms, t1.getTime())), s = state(sat, obs, d); if (!s) continue;
      out.push({ t: d, az: s.az, el: s.el, lit: isSunlit(s.r, sunEci(d)) });
    }
    return out;
  }

  // ---------- Sun, Moon, planets ----------
  const BODIES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
  function search(fn) { try { const r = fn(); return r ? (r.date || (r.time && r.time.date) || null) : null; } catch (e) { return null; } }
  function riseSet(name, obs, from) {
    const b = A.Body[name];
    return { rise: search(() => A.SearchRiseSet(b, obs.aobs0, +1, from, 1.2)), set: search(() => A.SearchRiseSet(b, obs.aobs0, -1, from, 1.2)),
      transit: search(() => A.SearchHourAngle(b, obs.aobs, 0, from, +1)) };
  }
  function altAz(name, obs, date) {
    const eq = A.Equator(A.Body[name], date, obs.aobs, true, true);
    let h = A.Horizon(date, obs.aobs, eq.ra, eq.dec, null);           // geometric
    if (h.altitude > -1) h = A.Horizon(date, obs.aobs, eq.ra, eq.dec, 'normal');  // refraction only near/above horizon
    return { alt: h.altitude, az: h.azimuth, ra: eq.ra, dec: eq.dec, dist: eq.dist };
  }
  function constellation(name, obs, date) {
    const j = A.Equator(A.Body[name], date, obs.aobs, false, true);
    return A.Constellation(j.ra, j.dec);
  }
  function twilight(obs, from) {               // next set of evening/morning events after `from`
    const s = A.Body.Sun, f = (dir, alt) => search(() => A.SearchAltitude(s, obs.aobs, dir, from, 1.2, alt));
    return { sunset: search(() => A.SearchRiseSet(s, obs.aobs0, -1, from, 1.2)), civilDusk: f(-1, -6), nauticalDusk: f(-1, -12), astroDusk: f(-1, -18),
      astroDawn: f(+1, -18), nauticalDawn: f(+1, -12), civilDawn: f(+1, -6), sunrise: search(() => A.SearchRiseSet(s, obs.aobs0, +1, from, 1.2)) };
  }
  function moonInfo(obs, date) {
    const ill = A.Illumination(A.Body.Moon, date), phase = A.MoonPhase(date);
    const q = []; let mq = A.SearchMoonQuarter(date);
    for (let i = 0; i < 4; i++) { q.push({ quarter: mq.quarter, date: mq.time.date }); mq = A.NextMoonQuarter(mq); }
    return { fraction: ill.phase_fraction, phaseAngle: phase, mag: ill.mag, quarters: q, distKm: A.GeoVector(A.Body.Moon, date, false).Length() * AU_KM };
  }
  function planetInfo(name, obs, date) {
    const ill = A.Illumination(A.Body[name], date), el = A.Elongation(A.Body[name], date), aa = altAz(name, obs, date);
    return { name, mag: ill.mag, elong: el.elongation, side: el.visibility, alt: aa.alt, az: aa.az, ra: aa.ra, dec: aa.dec,
      distAU: aa.dist, constellation: constellation(name, obs, date).name };
  }
  // Rotation from J2000 equatorial to the observer's horizon, for plotting stars.
  function horizonMatrix(obs, date) { return A.Rotation_EQJ_HOR(A.MakeTime(date), obs.aobs); }
  function starAltAz(m, raDeg, decDeg) {
    const ra = raDeg * DEG, dec = decDeg * DEG;
    const v = new A.Vector(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), A.MakeTime(new Date()));
    const h = A.RotateVector(m, v);
    // Astronomy-engine HOR frame: x = north, y = west, z = zenith
    const alt = Math.asin(Math.max(-1, Math.min(1, h.z))) / DEG;
    let az = Math.atan2(-h.y, h.x) / DEG; if (az < 0) az += 360;
    return { alt, az };
  }


  // ---------- Map helpers ----------
  function subsolar(date) {                    // sub-solar point (lat, lon) for day/night shading
    const t = A.MakeTime(date), g = A.RotateVector(A.Rotation_EQJ_EQD(t), A.GeoVector(A.Body.Sun, t, true));
    const ra = Math.atan2(g.y, g.x) / DEG, dec = Math.atan2(g.z, Math.hypot(g.x, g.y)) / DEG;
    let lon = ra - A.SiderealTime(t) * 15; lon = ((lon + 540) % 360) - 180;
    return { lat: dec, lon };
  }
  function moonAge(date) {                     // days since the previous new Moon
    let nm = A.SearchMoonPhase(0, new Date(date.getTime() - 30 * 864e5), 31);
    if (nm && nm.date > date) nm = A.SearchMoonPhase(0, new Date(date.getTime() - 60 * 864e5), 31);
    return nm ? (date - nm.date) / 864e5 : null;
  }

  // ---------- Spacecraft (JPL Horizons heliocentric vectors, ecliptic J2000, km) ----------
  const OBL = 23.4392911 * DEG;
  function probeState(p, obs, date) {
    const ep = p.epochs.map(e => Date.parse(e + 'T00:00:00Z'));
    let i = 0; while (i < ep.length - 1 && date.getTime() > ep[i + 1]) i++;
    if (date.getTime() < ep[0]) i = 0;
    const dt = (date.getTime() - ep[i]) / 1000;   // seconds from nearest earlier epoch (or first)
    const r = [0, 1, 2].map(k => p.r[i][k] + p.v[i][k] * dt);
    const v = p.v[i];
    // ecliptic J2000 -> equatorial J2000, km -> AU
    const x = r[0] / AU_KM, y = (r[1] * Math.cos(OBL) - r[2] * Math.sin(OBL)) / AU_KM, z = (r[1] * Math.sin(OBL) + r[2] * Math.cos(OBL)) / AU_KM;
    const e = A.HelioVector(A.Body.Earth, A.MakeTime(date));
    const gx = x - e.x, gy = y - e.y, gz = z - e.z, geo = Math.hypot(gx, gy, gz);
    let ra = Math.atan2(gy, gx) / DEG; if (ra < 0) ra += 360;
    const dec = Math.asin(gz / geo) / DEG, m = horizonMatrix(obs, date), h = starAltAz(m, ra, dec);
    return { name: p.name, sunAU: Math.hypot(x, y, z), earthAU: geo, lightHours: geo * AU_KM / 299792.458 / 3600, speed: Math.hypot(v[0], v[1], v[2]),
      ra, dec, constellation: A.Constellation(ra / 15, dec).name, alt: h.alt, az: h.az, extrapolated: date.getTime() > ep[ep.length - 1] + 30 * 864e5 || date.getTime() < ep[0] - 30 * 864e5,
      helio: { x, y, z } };
  }

  root.SkyEngine = { parseTLE, tleChecksumOK, tleEpoch, observer, state, isSunlit, sunEci, sunAlt, magnitude, geodetic, passes, track,
    riseSet, altAz, twilight, moonInfo, planetInfo, horizonMatrix, starAltAz, BODIES, subsolar, moonAge, probeState };
})(typeof globalThis !== 'undefined' ? globalThis : this);
