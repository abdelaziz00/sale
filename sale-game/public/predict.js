/*
 * FUT Market Radar — prediction engine.
 * Pure functions, no DOM. Works only on price history it is given; it never
 * invents prices. Every output is a statistical estimate, not a guarantee.
 */
(function (root) {
  'use strict';

  var HOUR = 3600e3;
  var EA_TAX = 0.05;
  var MIN_POINTS = 6;
  var MIN_SPAN_H = 6;

  // FC transfer-market price ladder (BIN increments).
  function roundToLadder(p) {
    var step = p < 1000 ? 50 : p < 10000 ? 100 : p < 50000 ? 250 : p < 100000 ? 500 : 1000;
    return Math.max(150, Math.round(p / step) * step);
  }

  // Accepts [[t, p], ...] or [{t, p}, ...]; drops invalid points, sorts by time,
  // and keeps the last value for duplicate timestamps.
  function cleanSeries(raw) {
    if (!Array.isArray(raw)) return [];
    var byT = {};
    raw.forEach(function (pt) {
      var t, v;
      if (Array.isArray(pt)) { t = pt[0]; v = pt[1]; }
      else if (pt && typeof pt === 'object') { t = pt.t; v = pt.p != null ? pt.p : pt.v; }
      t = Number(t); v = Number(v);
      if (isFinite(t) && isFinite(v) && v > 0 && t > 0) byT[t] = v;
    });
    return Object.keys(byT).map(Number).sort(function (a, b) { return a - b; })
      .map(function (t) { return { t: t, p: byT[t] }; });
  }

  // Weighted least squares y = a + b x. Returns slope, intercept and weighted R².
  function wls(xs, ys, ws) {
    var sw = 0, sx = 0, sy = 0, i;
    for (i = 0; i < xs.length; i++) { sw += ws[i]; sx += ws[i] * xs[i]; sy += ws[i] * ys[i]; }
    var mx = sx / sw, my = sy / sw, sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < xs.length; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      sxx += ws[i] * dx * dx; sxy += ws[i] * dx * dy; syy += ws[i] * dy * dy;
    }
    var b = sxx > 0 ? sxy / sxx : 0;
    var r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    return { slope: b, intercept: my - b * mx, r2: r2 };
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function timeEma(series, tauH) {
    var e = series[0].p;
    for (var i = 1; i < series.length; i++) {
      var dt = (series[i].t - series[i - 1].t) / HOUR;
      var a = 1 - Math.exp(-dt / tauH);
      e = e + a * (series[i].p - e);
    }
    return e;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function eventApplies(ev, player) {
    if (ev.minRating && !(player.rating >= ev.minRating)) return false;
    if (ev.maxRating && !(player.rating <= ev.maxRating)) return false;
    if (Array.isArray(ev.positions) && ev.positions.length && ev.positions.indexOf(player.position) === -1) return false;
    if (Array.isArray(ev.playerIds) && ev.playerIds.length && ev.playerIds.indexOf(player.id) === -1) return false;
    return true;
  }

  /*
   * Builds the factor model once; terms(h) returns each factor's log-price
   * contribution at h hours ahead so the curve and ETA share one formula.
   */
  function buildModel(player, opts) {
    var hist = cleanSeries(player.history);
    if (hist.length < MIN_POINTS) {
      return { ok: false, reason: 'Not enough price history: ' + hist.length + ' of ' + MIN_POINTS + ' data points needed.', points: hist.length };
    }
    var first = hist[0], last = hist[hist.length - 1];
    var spanH = (last.t - first.t) / HOUR;
    if (spanH < MIN_SPAN_H) {
      return { ok: false, reason: 'Price history covers only ' + spanH.toFixed(1) + 'h; at least ' + MIN_SPAN_H + 'h needed.', points: hist.length };
    }

    var now = opts.now;
    var current = Number(player.price) > 0 ? Number(player.price) : last.p;

    // 1) Trend: recency-weighted log-linear fit over the last 72h (half-life 24h).
    var win = hist.filter(function (pt) { return pt.t >= last.t - 72 * HOUR; });
    if (win.length < MIN_POINTS) win = hist.slice(-MIN_POINTS);
    var xs = win.map(function (pt) { return (pt.t - last.t) / HOUR; });
    var ys = win.map(function (pt) { return Math.log(pt.p); });
    var ws = xs.map(function (x) { return Math.pow(2, x / 24); });
    var fit = wls(xs, ys, ws);

    // 2) Volatility: per-sqrt-hour stdev of log returns.
    var acc = 0, cnt = 0;
    for (var i = 1; i < hist.length; i++) {
      var dt = (hist[i].t - hist[i - 1].t) / HOUR;
      if (dt <= 0) continue;
      var r = Math.log(hist[i].p / hist[i - 1].p);
      acc += (r * r) / dt; cnt++;
    }
    var volH = Math.max(0.002, Math.sqrt(cnt ? acc / cnt : 0));

    // 3) Momentum: fast vs slow EMA.
    var momentum = Math.log(timeEma(hist, 12) / timeEma(hist, 48));

    // 4) Mean reversion against the 7-day median.
    var week = hist.filter(function (pt) { return pt.t >= last.t - 168 * HOUR; }).map(function (pt) { return pt.p; });
    var med = median(week);
    var dev = Math.log(current / med);

    // 5) Supply: listing-count trend over 48h (shrinking supply is bullish).
    var supply = null;
    var lst = cleanSeries(player.listings).filter(function (pt) { return pt.t >= last.t - 48 * HOUR; });
    if (lst.length >= 4) {
      var lfit = wls(lst.map(function (pt) { return (pt.t - last.t) / HOUR; }),
        lst.map(function (pt) { return Math.log(pt.p); }), lst.map(function () { return 1; }));
      var lspan = Math.max(1, (lst[lst.length - 1].t - lst[0].t) / HOUR);
      supply = { slopeH: lfit.slope, spanH: lspan, change: Math.exp(lfit.slope * lspan) - 1, latest: lst[lst.length - 1].p };
    }

    // 6) Configured events (promos, SBCs) that apply to this player.
    var events = (opts.events || []).filter(function (ev) {
      var s = Date.parse(ev.start);
      return isFinite(s) && s > now && isFinite(Number(ev.impactPct)) && eventApplies(ev, player);
    }).map(function (ev) { return { name: String(ev.name || 'Event'), start: Date.parse(ev.start), impactPct: Number(ev.impactPct) }; });

    var ageH = Math.max(0, (now - last.t) / HOUR);

    function terms(h) {
      var tau = 24;
      var out = {
        trend: fit.slope * tau * (1 - Math.exp(-h / tau)) * (0.4 + 0.6 * fit.r2),
        momentum: 0.25 * momentum * (1 - Math.exp(-h / 12)),
        reversion: -0.25 * dev * (1 - Math.exp(-h / 48)),
        supply: supply ? clamp(-0.3 * supply.slopeH * Math.min(h, 48), -0.08, 0.08) : 0,
        events: 0
      };
      events.forEach(function (ev) {
        if (ev.start <= now + h * HOUR) out.events += 0.6 * Math.log(1 + ev.impactPct / 100);
      });
      return out;
    }
    function total(h) {
      var t = terms(h);
      return clamp(t.trend + t.momentum + t.reversion + t.supply + t.events, -0.5, 0.5);
    }

    return {
      ok: true, hist: hist, current: current, last: last, fit: fit, volH: volH, momentum: momentum,
      median7d: med, dev: dev, supply: supply, events: events, ageH: ageH, n: win.length, spanH: spanH,
      terms: terms, total: total
    };
  }

  function pctStr(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }

  function explain(m, H, tot, terms) {
    var lines = [];
    var perDay = Math.exp(m.fit.slope * 24) - 1;
    var items = [
      { k: 'trend', v: terms.trend, text: (perDay >= 0 ? 'Uptrend' : 'Downtrend') + ' of ' + pctStr(perDay) + '/day over recent history (fit R² ' + m.fit.r2.toFixed(2) + ').' },
      { k: 'momentum', v: terms.momentum, text: 'Short-term average is ' + pctStr(Math.exp(m.momentum) - 1) + ' vs the 2-day average — ' + (m.momentum >= 0 ? 'buyers are pushing price up.' : 'selling pressure is dominant.') },
      { k: 'reversion', v: terms.reversion, text: 'Price is ' + pctStr(Math.exp(m.dev) - 1) + ' vs its 7-day median (' + Math.round(m.median7d).toLocaleString('en-US') + ') — ' + (m.dev < 0 ? 'room to recover.' : 'may cool off.') },
      { k: 'supply', v: terms.supply, text: m.supply ? 'Listings ' + pctStr(m.supply.change) + ' over ' + Math.round(m.supply.spanH) + 'h (now ' + m.supply.latest.toLocaleString('en-US') + ') — supply ' + (m.supply.change < 0 ? 'tightening.' : 'growing.') : '' },
      { k: 'events', v: terms.events, text: m.events.length ? m.events.map(function (ev) { return ev.name + ' starts ' + new Date(ev.start).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' (configured impact ' + pctStr(ev.impactPct / 100) + ').'; }).join(' ') : '' }
    ];
    items.filter(function (it) { return it.text && Math.abs(it.v) >= 0.002; })
      .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); })
      .forEach(function (it) { lines.push({ factor: it.k, direction: it.v >= 0 ? 'up' : 'down', weight: it.v, text: it.text }); });
    if (!lines.length) lines.push({ factor: 'flat', direction: 'flat', weight: 0, text: 'No factor moves the price meaningfully; the market looks balanced.' });
    var sigma = m.volH * Math.sqrt(H);
    if (sigma > Math.abs(tot) * 1.5 && sigma > 0.03) {
      lines.push({ factor: 'risk', direction: 'risk', weight: 0, text: 'High volatility (±' + (sigma * 100).toFixed(1) + '% typical ' + H + 'h swing) — the forecast is uncertain.' });
    }
    if (m.ageH > 6) lines.push({ factor: 'risk', direction: 'risk', weight: 0, text: 'Latest price is ' + Math.round(m.ageH) + 'h old; confidence reduced.' });
    return lines;
  }

  /**
   * predict(player, { horizonH, now, events }) → forecast object.
   * player: { id, rating, position, price, history: [[t,p]|{t,p}], listings? }
   */
  function predict(player, options) {
    var opts = { horizonH: 24, now: Date.now(), events: [] };
    for (var k in options) if (options[k] !== undefined) opts[k] = options[k];
    var H = clamp(Number(opts.horizonH) || 24, 1, 168);
    var m = buildModel(player, opts);
    if (!m.ok) return m;

    var tot = m.total(H);
    var terms = m.terms(H);
    var cur = m.current;
    var predicted = roundToLadder(cur * Math.exp(tot));
    var sigma = m.volH * Math.sqrt(H);
    var change = predicted - cur;
    var pct = change / cur;

    // Confidence: fit quality, sample size, signal-to-noise and freshness.
    var snr = Math.abs(tot) / (sigma + 1e-9);
    var fresh = m.ageH <= 1 ? 1 : m.ageH <= 6 ? 0.9 : m.ageH <= 24 ? 0.7 : 0.45;
    var sample = Math.min(1, m.n / 36);
    var conf = clamp(Math.round(100 * (0.30 * m.fit.r2 + 0.20 * sample + 0.50 * (snr / (snr + 1))) * fresh), 5, 95);
    var label = conf >= 70 ? 'High' : conf >= 45 ? 'Medium' : 'Low';

    // ETA: first hour the forecast curve clears +2% (enough to matter after noise).
    var etaH = null;
    if (pct > 0) {
      for (var h = 1; h <= H; h++) {
        if (Math.exp(m.total(h)) - 1 >= 0.02) { etaH = h; break; }
      }
      if (etaH === null && pct >= 0.005) etaH = H;
    }

    var curve = [];
    var steps = 24;
    for (var s = 0; s <= steps; s++) {
      var hh = (H * s) / steps;
      var lp = m.total(hh), sg = m.volH * Math.sqrt(hh);
      curve.push({ t: opts.now + hh * HOUR, p: cur * Math.exp(lp), lo: cur * Math.exp(lp - sg), hi: cur * Math.exp(lp + sg) });
    }

    return {
      ok: true,
      horizonH: H,
      current: cur,
      predicted: predicted,
      change: change,
      pct: pct,
      netAfterTax: Math.round(predicted * (1 - EA_TAX) - cur),
      low: roundToLadder(cur * Math.exp(tot - sigma)),
      high: roundToLadder(cur * Math.exp(tot + sigma)),
      confidence: conf,
      confidenceLabel: label,
      etaH: etaH,
      etaMs: etaH === null ? null : opts.now + etaH * HOUR,
      r2: m.fit.r2,
      volH: m.volH,
      points: m.hist.length,
      history: m.hist,
      curve: curve,
      factors: terms,
      explanation: explain(m, H, tot, terms)
    };
  }

  var api = { predict: predict, cleanSeries: cleanSeries, roundToLadder: roundToLadder, wls: wls, EA_TAX: EA_TAX, MIN_POINTS: MIN_POINTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FutPredict = api;
})(typeof window !== 'undefined' ? window : this);
