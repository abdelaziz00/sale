/* FUT Market Radar — dashboard controller. */
(function () {
  'use strict';

  var POLL_MS = 5000;
  var TIMEOUT_MS = 4500;
  var HOUR = 3600e3;
  var params = new URLSearchParams(location.search);
  var fixture = params.get('fixture');
  var apiUrl = '/api/market' + (fixture ? '?fixture=' + encodeURIComponent(fixture) : '');

  var state = {
    mode: null, version: null, sources: [], events: [], players: [], rows: [], staleAfterSec: 900,
    malformed: 0, lastOkAt: null, lastAttemptAt: null, error: null, inflight: false, paused: false,
    timer: null, nextAt: null, polls: 0, renders: 0, skipped: 0
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US'); };
  var signed = function (n) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n)); };
  var signedPct = function (x) { return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x * 100).toFixed(1) + '%'; };
  function ago(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function clock(ms) { return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function safeUrl(u, allowRelative) {
    if (typeof u !== 'string' || !u) return null;
    if (allowRelative && /^\/[^/]/.test(u)) return u;
    try { var x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; }
  }

  // ---------- filters (persisted per browser) ----------
  var filterIds = ['fSearch', 'fHorizon', 'fSort', 'fConf', 'fMin', 'fMax', 'fRising'];
  function readFilters() {
    return {
      q: $('fSearch').value.trim().toLowerCase(),
      horizon: Number($('fHorizon').value) || 24,
      sort: $('fSort').value,
      minConf: Number($('fConf').value) || 0,
      min: $('fMin').value === '' ? null : Number($('fMin').value),
      max: $('fMax').value === '' ? null : Number($('fMax').value),
      rising: $('fRising').checked
    };
  }
  function saveFilters() {
    try {
      var o = {}; filterIds.forEach(function (id) { var n = $(id); o[id] = n.type === 'checkbox' ? n.checked : n.value; });
      localStorage.setItem('fmr-filters', JSON.stringify(o));
    } catch (e) { /* storage unavailable */ }
  }
  function loadFilters() {
    try {
      var o = JSON.parse(localStorage.getItem('fmr-filters') || '{}');
      filterIds.forEach(function (id) { if (id in o) { var n = $(id); if (n.type === 'checkbox') n.checked = !!o[id]; else n.value = o[id]; } });
    } catch (e) { /* ignore */ }
    $('fConfOut').textContent = $('fConf').value;
  }

  // ---------- data ingestion ----------
  function normalisePlayer(raw, src, timeBase, genAt) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var price = Number(raw.price);
    if (!raw.id || !raw.name || !isFinite(price) || price <= 0 || !Array.isArray(raw.history)) return null;
    var shift = function (series) {
      if (!Array.isArray(series)) return [];
      return series.map(function (pt) {
        var t = Array.isArray(pt) ? pt[0] : pt && pt.t, v = Array.isArray(pt) ? pt[1] : pt && (pt.p != null ? pt.p : pt.v);
        return [Number(t) + (timeBase === 'relative' ? genAt : 0), Number(v)];
      });
    };
    var updated = Number(raw.priceUpdatedAt);
    if (!isFinite(updated)) updated = Date.parse(raw.priceUpdatedAt);
    if (isFinite(updated) && timeBase === 'relative') updated += genAt;
    return {
      id: String(raw.id), name: String(raw.name).slice(0, 80), rating: Number(raw.rating) || null,
      position: raw.position ? String(raw.position).slice(0, 4).toUpperCase() : '—',
      imageUrl: safeUrl(raw.imageUrl, true), sourceUrl: safeUrl(raw.sourceUrl, false),
      price: price, priceUpdatedAt: isFinite(updated) ? updated : null,
      history: shift(raw.history), listings: shift(raw.listings), sources: [src.name], sourceStatus: src.status
    };
  }

  function ingest(json) {
    if (!json || !Array.isArray(json.sources)) throw new Error('Unexpected response shape from backend');
    state.sources = json.sources;
    state.mode = json.mode;
    state.staleAfterSec = Number(json.staleAfterSec) || 900;
    if (json.version === state.version) { state.skipped++; return false; }
    state.version = json.version;

    var genAt = Date.parse(json.generatedAt) || Date.now();
    var byId = {}, malformed = 0;
    json.sources.forEach(function (src) {
      var pl = src.payload;
      if (!pl) return;
      if (!Array.isArray(pl.players)) { malformed++; return; }
      // Relative timestamps are only honoured for QA fixtures, never for live feeds.
      var tb = json.mode === 'fixture' && pl.timeBase === 'relative' ? 'relative' : 'absolute';
      pl.players.forEach(function (raw) {
        var p = normalisePlayer(raw, src, tb, genAt);
        if (!p) { malformed++; return; }
        var ex = byId[p.id];
        if (!ex) { byId[p.id] = p; return; }
        // Same player from several sources: union histories, keep the freshest price.
        ex.history = ex.history.concat(p.history);
        ex.listings = ex.listings.concat(p.listings);
        ex.sources.push(p.sources[0]);
        if ((p.priceUpdatedAt || 0) > (ex.priceUpdatedAt || 0)) { ex.price = p.price; ex.priceUpdatedAt = p.priceUpdatedAt; }
      });
    });
    state.players = Object.keys(byId).map(function (k) { return byId[k]; });
    state.malformed = malformed;
    state.events = (Array.isArray(json.events) ? json.events : []).map(function (ev) {
      if (!ev || typeof ev !== 'object') return null;
      var start = ev.start;
      if (!start && json.mode === 'fixture' && isFinite(ev.startOffsetH)) start = new Date(genAt + ev.startOffsetH * HOUR).toISOString();
      return start ? Object.assign({}, ev, { start: start }) : null;
    }).filter(Boolean);
    return true;
  }

  function computeForecasts() {
    var f = readFilters(), now = Date.now();
    state.players.forEach(function (p) {
      p.forecast = window.FutPredict.predict(p, { horizonH: f.horizon, now: now, events: state.events });
      p.stale = (p.priceUpdatedAt != null && now - p.priceUpdatedAt > state.staleAfterSec * 1000) ||
        p.sourceStatus === 'stale' || p.sourceStatus === 'error';
    });
  }

  // ---------- polling ----------
  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = null; state.nextAt = null;
    if (state.paused || document.hidden) return;
    var d = delay == null ? POLL_MS : delay;
    state.nextAt = Date.now() + d;
    state.timer = setTimeout(poll, d);
  }

  function poll() {
    if (state.inflight) return;
    state.inflight = true; state.polls++; state.lastAttemptAt = Date.now();
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    fetch(apiUrl, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (b) {
            throw new Error('HTTP ' + res.status + (b && b.error ? ' — ' + b.error : ''));
          });
        }
        return res.json();
      })
      .then(function (json) {
        var changed = ingest(json);
        state.lastOkAt = Date.now(); state.error = null;
        if (changed) { computeForecasts(); renderData(); }
      })
      .catch(function (e) {
        state.error = e && e.name === 'AbortError' ? 'Request timed out after ' + TIMEOUT_MS / 1000 + 's' :
          (e && e.message === 'Failed to fetch' ? 'Backend unreachable — is server.ps1 running?' : String(e && e.message || e));
      })
      .then(function () {
        clearTimeout(to);
        state.inflight = false;
        renderStatus(); renderSources();
        if (state.mode === null) renderGrid();
        schedule();
      });
  }

  // ---------- rendering ----------
  function renderStatus() {
    var dot = $('liveDot'), label = $('liveLabel');
    var okSources = state.sources.filter(function (s) { return s.status === 'ok'; });
    var staleSources = state.sources.filter(function (s) { return s.status === 'stale' || s.status === 'error'; });
    var cls, text;
    if (state.error && !state.lastOkAt) { cls = 'err'; text = 'Offline — no data'; }
    else if (state.error) { cls = 'err'; text = 'Update failed — showing last good data'; }
    else if (!state.lastOkAt) { cls = ''; text = 'Connecting…'; }
    else if (!okSources.length) { cls = 'warn'; text = state.players.length ? 'No live source — data may be outdated' : 'No market data source connected'; }
    else if (staleSources.length || state.players.some(function (p) { return p.stale; })) { cls = 'warn'; text = 'Partially outdated data'; }
    else { cls = 'ok'; text = state.mode === 'fixture' ? 'Live (test fixture)' : 'Live'; }
    if (state.paused) { cls = 'warn'; text = 'Paused — ' + text; }
    dot.className = 'dot ' + cls;
    label.textContent = text;
    tickMeta();
  }

  function tickMeta() {
    var parts = [];
    parts.push(state.lastOkAt ? 'Last successful update ' + clock(state.lastOkAt) + ' (' + ago(state.lastOkAt) + ')' : 'No successful update yet');
    if (state.error) parts.push(state.error);
    else if (state.inflight) parts.push('updating…');
    else if (state.nextAt) parts.push('next in ' + Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000)) + 's');
    $('liveMeta').textContent = parts.join(' · ');
    var upstream = state.sources.reduce(function (a, s) { return a + (Number(s.upstreamFetches) || 0); }, 0);
    $('footStats').textContent = 'Polls: ' + state.polls + ' · Re-renders: ' + state.renders + ' · Unchanged (skipped): ' + state.skipped + ' · Upstream fetches: ' + upstream;
  }

  function renderSources() {
    var box = $('sources');
    box.textContent = '';
    if (!state.sources.length) return;
    state.sources.forEach(function (s) {
      var c = el('div', 'src-card ' + s.status);
      var top = el('div', 'src-top');
      top.appendChild(el('span', 'src-name', s.name));
      var label = { ok: 'Connected', stale: 'Outdated', error: 'Error', disabled: 'Not connected', empty: 'No data', pending: 'Pending' }[s.status] || s.status;
      top.appendChild(el('span', 'pill ' + s.status, label));
      c.appendChild(top);
      if (s.message) c.appendChild(el('p', 'src-msg', s.message));
      var asOf = Date.parse(s.dataAsOf || s.lastSuccess);
      if (s.status !== 'disabled') {
        c.appendChild(el('div', 'src-time', isFinite(asOf) ? 'Data as of ' + new Date(asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + ago(asOf) + ')' : 'No successful fetch yet'));
      }
      box.appendChild(c);
    });
    if (state.malformed) {
      var w = el('div', 'src-card error');
      w.appendChild(el('span', 'src-name', 'Data quality'));
      w.appendChild(el('p', 'src-msg', state.malformed + ' malformed record(s) were skipped and are not shown.'));
      box.appendChild(w);
    }
  }

  function rowsFor(f) {
    var sorters = {
      pct: function (p) { return p.forecast.ok ? p.forecast.pct : -Infinity; },
      net: function (p) { return p.forecast.ok ? p.forecast.netAfterTax : -Infinity; },
      change: function (p) { return p.forecast.ok ? p.forecast.change : -Infinity; },
      confidence: function (p) { return p.forecast.ok ? p.forecast.confidence : -Infinity; },
      eta: function (p) { return p.forecast.ok && p.forecast.etaH != null ? -p.forecast.etaH : -Infinity; },
      price: function (p) { return p.price; },
      rating: function (p) { return p.rating || 0; }
    };
    var key = sorters[f.sort] || sorters.pct;
    return state.players.filter(function (p) {
      if (f.q && (p.name + ' ' + p.position).toLowerCase().indexOf(f.q) === -1) return false;
      if (f.min != null && p.price < f.min) return false;
      if (f.max != null && p.price > f.max) return false;
      if (f.rising && !(p.forecast.ok && p.forecast.pct > 0)) return false;
      if (f.minConf > 0 && !(p.forecast.ok && p.forecast.confidence >= f.minConf)) return false;
      return true;
    }).sort(function (a, b) { return key(b) - key(a) || a.name.localeCompare(b.name); });
  }

  function renderKpis() {
    var box = $('kpis');
    box.textContent = '';
    var ok = state.players.filter(function (p) { return p.forecast && p.forecast.ok; });
    var risers = ok.filter(function (p) { return p.forecast.pct > 0; });
    var avg = risers.length ? risers.reduce(function (a, p) { return a + p.forecast.pct; }, 0) / risers.length : null;
    var best = risers.reduce(function (b, p) { return !b || p.forecast.netAfterTax > b.forecast.netAfterTax ? p : b; }, null);
    var hi = risers.filter(function (p) { return p.forecast.confidenceLabel === 'High'; }).length;
    [
      ['Players tracked', fmt(state.players.length), '', ok.length + ' with enough history to forecast'],
      ['Predicted risers', fmt(risers.length), risers.length ? 'up' : '', hi + ' with high confidence'],
      ['Avg expected gain', avg == null ? '—' : signedPct(avg), avg == null ? '' : 'up', 'across predicted risers'],
      ['Best profit after tax', best ? signed(best.forecast.netAfterTax) : '—', best && best.forecast.netAfterTax > 0 ? 'up' : best ? 'down' : '', best ? best.name : 'coins, per card']
    ].forEach(function (k) {
      var d = el('div', 'kpi');
      d.appendChild(el('div', 'k', k[0]));
      d.appendChild(el('div', 'v ' + k[2], k[1]));
      var sub = el('div', 's', k[3]);
      sub.title = k[3];
      d.appendChild(sub);
      box.appendChild(d);
    });
  }

  function chartSvg(p, dir) {
    var fc = p.forecast, hz = fc.horizonH;
    var spanBack = hz >= 72 ? 168 : 72;
    var tEnd = fc.curve[fc.curve.length - 1].t, tStart = tEnd - (spanBack + hz) * HOUR;
    var hist = fc.history.filter(function (pt) { return pt.t >= tStart; });
    var pts = hist.map(function (pt) { return pt.p; });
    fc.curve.forEach(function (c) { pts.push(c.lo, c.hi); });
    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    var pad = (hi - lo) * 0.08 || hi * 0.02;
    lo -= pad; hi += pad;
    var W = 320, Hh = 110, L = 4, R = 46, T = 6, B = 16;
    var x = function (t) { return (L + (t - tStart) / (tEnd - tStart) * (W - L - R)).toFixed(1); };
    var y = function (v) { return (T + (1 - (v - lo) / (hi - lo)) * (Hh - T - B)).toFixed(1); };
    var color = dir === 'up' ? 'var(--up)' : dir === 'down' ? 'var(--down)' : 'var(--muted)';
    var histPath = hist.map(function (pt, i) { return (i ? 'L' : 'M') + x(pt.t) + ' ' + y(pt.p); }).join('');
    var fcPath = fc.curve.map(function (c, i) { return (i ? 'L' : 'M') + x(c.t) + ' ' + y(c.p); }).join('');
    var band = fc.curve.map(function (c) { return x(c.t) + ',' + y(c.hi); }).concat(fc.curve.slice().reverse().map(function (c) { return x(c.t) + ',' + y(c.lo); })).join(' ');
    var nowX = x(fc.curve[0].t);
    var short = function (v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'K' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : Math.round(v); };
    return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" role="img" aria-label="Price history and forecast">' +
      '<line class="grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(hi - pad) + '" y2="' + y(hi - pad) + '"/>' +
      '<line class="grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(lo + pad) + '" y2="' + y(lo + pad) + '"/>' +
      '<text class="axis" x="' + (W - R + 4) + '" y="' + (Number(y(hi - pad)) + 3) + '">' + short(hi - pad) + '</text>' +
      '<text class="axis" x="' + (W - R + 4) + '" y="' + (Number(y(lo + pad)) + 3) + '">' + short(lo + pad) + '</text>' +
      '<polygon points="' + band + '" fill="' + color + '" opacity=".13"/>' +
      '<line class="now" x1="' + nowX + '" x2="' + nowX + '" y1="' + T + '" y2="' + (Hh - B) + '"/>' +
      '<text class="axis" x="' + nowX + '" y="' + (Hh - 4) + '" text-anchor="middle">now</text>' +
      '<text class="axis" x="' + L + '" y="' + (Hh - 4) + '">−' + spanBack + 'h</text>' +
      '<text class="axis" x="' + (W - R) + '" y="' + (Hh - 4) + '" text-anchor="end">+' + hz + 'h</text>' +
      '<path class="hist" d="' + histPath + '" vector-effect="non-scaling-stroke"/>' +
      '<path class="fc" d="' + fcPath + '" stroke="' + color + '" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
  }

  function artFor(p) {
    var box = el('div', 'art');
    var mini = function () {
      var m = el('div', 'mini' + ((p.rating || 0) < 75 ? ' silver' : ''));
      m.setAttribute('role', 'img');
      m.setAttribute('aria-label', p.name + ' card placeholder');
      m.appendChild(el('b', null, p.rating || '?'));
      m.appendChild(el('i', null, p.position));
      return m;
    };
    if (p.imageUrl) {
      var img = new Image();
      img.alt = p.name + ' card';
      img.referrerPolicy = 'no-referrer';
      img.onerror = function () { box.textContent = ''; box.appendChild(mini()); };
      img.src = p.imageUrl;
      box.appendChild(img);
    } else box.appendChild(mini());
    return box;
  }

  function cardFor(p) {
    var tpl = $('cardTpl').content.firstElementChild.cloneNode(true);
    var fc = p.forecast;
    var dir = fc.ok ? (fc.pct > 0.001 ? 'up' : fc.pct < -0.001 ? 'down' : 'flat') : 'flat';
    tpl.classList.add(dir);
    if (p.stale) tpl.classList.add('stale');
    tpl.querySelector('.art').replaceWith(artFor(p));
    tpl.querySelector('.name').textContent = p.name;
    tpl.querySelector('.name').title = p.name;
    var tags = tpl.querySelector('.tags');
    tags.appendChild(el('span', 'tag gold', (p.rating || '?') + ' OVR'));
    tags.appendChild(el('span', 'tag', p.position));
    if (p.stale) tags.appendChild(el('span', 'tag', 'Outdated price'));

    var conf = tpl.querySelector('.conf');
    if (fc.ok) {
      var ring = el('div', 'ring');
      ring.style.setProperty('--p', fc.confidence);
      ring.style.setProperty('--c', fc.confidenceLabel === 'High' ? 'var(--up)' : fc.confidenceLabel === 'Medium' ? 'var(--gold)' : 'var(--down)');
      ring.appendChild(el('span', null, fc.confidence + '%'));
      ring.title = 'Prediction confidence';
      conf.appendChild(ring);
      conf.appendChild(el('span', 'cl', fc.confidenceLabel + ' confidence'));
    }

    var actual = tpl.querySelector('.price.actual');
    actual.querySelector('.src').textContent = '· ' + p.sources.join(' + ');
    var av = actual.querySelector('.val');
    av.appendChild(el('span', 'coin'));
    av.appendChild(document.createTextNode(fmt(p.price)));
    actual.querySelector('.age').textContent = p.priceUpdatedAt ? 'as of ' + ago(p.priceUpdatedAt) : 'time unknown';

    var fcBox = tpl.querySelector('.price.forecast');
    var foot = tpl.querySelector('.card-foot');
    if (!fc.ok) {
      tpl.querySelector('.prices').classList.add('no-fc');
      fcBox.querySelector('.hz').textContent = '';
      fcBox.querySelector('.val').textContent = '—';
      fcBox.querySelector('.range').textContent = 'no forecast';
      var ins = el('div', 'insufficient');
      ins.appendChild(el('b', null, 'No forecast yet. '));
      ins.appendChild(document.createTextNode(fc.reason + ' Keep logging prices to unlock a prediction.'));
      tpl.querySelector('.deltas').replaceWith(ins);
      tpl.querySelector('.chart').remove();
      tpl.querySelector('.why').remove();
    } else {
      fcBox.querySelector('.hz').textContent = '· est. +' + fc.horizonH + 'h';
      var fv = fcBox.querySelector('.val');
      fv.appendChild(el('span', 'coin'));
      fv.appendChild(document.createTextNode(fmt(fc.predicted)));
      fcBox.querySelector('.range').textContent = 'likely ' + fmt(fc.low) + ' – ' + fmt(fc.high);

      var d = tpl.querySelector('.deltas');
      var mk = function (cls, main, sub) { var b = el('div', 'delta ' + cls); b.appendChild(document.createTextNode(main)); b.appendChild(el('small', null, sub)); return b; };
      d.appendChild(mk(dir, signedPct(fc.pct), 'expected change'));
      d.appendChild(mk(dir, signed(fc.change), 'coins'));
      d.appendChild(mk(fc.netAfterTax > 0 ? 'up' : 'down', signed(fc.netAfterTax), 'profit after 5% tax'));
      var eta;
      if (fc.etaH != null) eta = 'in ~' + fc.etaH + 'h · ' + new Date(fc.etaMs).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      else eta = fc.pct > 0 ? 'slow drift' : 'no rise expected';
      d.appendChild(mk((fc.etaH != null ? 'up' : 'flat') + ' eta', eta, 'estimated rise time'));

      var chart = tpl.querySelector('.chart');
      chart.innerHTML = chartSvg(p, dir);
      var lg = el('div', 'legend');
      var l1 = el('span'); l1.appendChild(el('i')); l1.appendChild(document.createTextNode('Actual price'));
      var l2 = el('span'); var i2 = el('i', 'fc'); i2.style.borderTopColor = dir === 'up' ? 'var(--up)' : dir === 'down' ? 'var(--down)' : 'var(--muted)';
      l2.appendChild(i2); l2.appendChild(document.createTextNode('Forecast (estimate) ± 1σ'));
      lg.appendChild(l1); lg.appendChild(l2);
      chart.appendChild(lg);

      var why = tpl.querySelector('.why');
      fc.explanation.slice(0, 4).forEach(function (x) { why.appendChild(el('li', x.direction, x.text)); });
    }
    foot.appendChild(el('span', null, (fc.points || (fc.ok ? fc.history.length : 0)) + ' price points' + (fc.ok ? ' · fit R² ' + fc.r2.toFixed(2) : '')));
    if (p.sourceUrl) {
      var a = el('a', null, 'View source ↗');
      a.href = p.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
      foot.appendChild(a);
    }
    return tpl;
  }

  function stateBox(title, lines, button) {
    var s = el('div', 'state');
    s.appendChild(el('h2', null, title));
    lines.forEach(function (l) { s.appendChild(el('p', null, l)); });
    if (button) {
      var b = el('button', 'btn primary', button[0]);
      b.type = 'button';
      b.addEventListener('click', button[1]);
      s.appendChild(b);
    }
    return s;
  }

  function renderGrid() {
    var grid = $('grid');
    var frag = document.createDocumentFragment();
    var f = readFilters();
    var count = $('resultCount');
    if (state.mode === null) {
      grid.setAttribute('aria-busy', state.error ? 'false' : 'true');
      if (state.error) {
        var unreachable = /unreachable|timed out/i.test(state.error);
        frag.appendChild(stateBox('Can’t load market data', [state.error, unreachable ?
          'Start the backend with start.cmd (or: powershell -File server.ps1). This page retries automatically every 5 seconds.' :
          'The backend responded with an error. No prices are shown rather than guessing; this page retries automatically every 5 seconds.'],
        ['Retry now', function () { schedule(0); }]));
      } else {
        for (var i = 0; i < 6; i++) frag.appendChild(el('div', 'skeleton'));
      }
      count.textContent = '';
    } else if (!state.players.length) {
      grid.setAttribute('aria-busy', 'false');
      frag.appendChild(stateBox('No market data yet', [
        'No connected source has supplied any player prices, so there is nothing to forecast. Prices are never invented.',
        'Connect a licensed feed in config.json, or log the prices you see on FUT.GG / FUTBIN — forecasts appear after 6 observations spanning 6+ hours.'
      ], state.mode === 'fixture' ? null : ['+ Log a price', openLog]));
      count.textContent = '';
    } else {
      grid.setAttribute('aria-busy', 'false');
      var rows = rowsFor(f);
      if (!rows.length) {
        var anyRiser = state.players.some(function (p) { return p.forecast.ok && p.forecast.pct > 0; });
        var anyForecast = state.players.some(function (p) { return p.forecast.ok; });
        var title = 'No players match your filters', msg = 'Loosen the search, price or confidence filters.';
        if (f.rising && !anyForecast) {
          title = 'Not enough price history yet';
          msg = 'None of the ' + state.players.length + ' tracked player(s) has enough history to forecast (6 observations over 6+ hours). Untick “Predicted risers only” to see their current prices.';
        } else if (f.rising && !anyRiser) {
          title = 'No predicted risers';
          msg = 'None of the ' + state.players.length + ' tracked players is forecast to rise within ' + f.horizon + 'h. Try a longer horizon or show all players.';
        }
        frag.appendChild(stateBox(title, [msg], ['Show all players', resetFilters]));
      } else rows.forEach(function (p) { frag.appendChild(cardFor(p)); });
      count.textContent = 'Showing ' + rows.length + ' of ' + state.players.length + ' players · forecasts for the next ' + f.horizon + 'h · actual prices are solid, forecasts are dashed/italic';
    }
    grid.textContent = '';
    grid.appendChild(frag);
  }

  function renderData() {
    state.renders++;
    $('fixtureBanner').hidden = state.mode !== 'fixture';
    $('fixtureName').textContent = fixture || '';
    $('logBtn').disabled = state.mode === 'fixture';
    $('logBtn').title = state.mode === 'fixture' ? 'Logging is disabled while viewing test fixtures' : '';
    renderKpis();
    renderGrid();
    var dl = $('knownPlayers');
    dl.textContent = '';
    state.players.forEach(function (p) { var o = el('option'); o.value = p.name; dl.appendChild(o); });
  }

  function resetFilters() {
    $('fSearch').value = ''; $('fConf').value = 0; $('fConfOut').textContent = '0';
    $('fMin').value = ''; $('fMax').value = ''; $('fRising').checked = false;
    saveFilters(); renderGrid();
  }

  // ---------- log dialog ----------
  function openLog() {
    var d = $('logDialog');
    $('logError').textContent = '';
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    d.querySelector('input[name=name]').focus();
  }
  function closeLog() { var d = $('logDialog'); if (d.close) d.close(); else d.removeAttribute('open'); }

  function submitLog(ev) {
    ev.preventDefault();
    var form = $('logForm'), err = $('logError');
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
    if (!form.checkValidity()) {
      var bad = form.querySelector(':invalid');
      var v = bad.validity, field = bad.closest('label').querySelector('span').textContent.replace(' *', '');
      err.textContent = field + (v.valueMissing ? ' is required.' :
        v.rangeUnderflow || v.rangeOverflow ? ' must be between ' + Number(bad.min).toLocaleString('en-US') + ' and ' + Number(bad.max || Infinity).toLocaleString('en-US') + '.' :
        v.typeMismatch ? ' must be a valid https:// URL.' : ' is invalid.');
      bad.focus();
      return;
    }
    if (data.observedAt) {
      var t = new Date(data.observedAt).getTime();
      if (!isFinite(t)) { err.textContent = 'Invalid observation time.'; return; }
      data.observedAt = t;
    }
    $('logSubmit').disabled = true;
    err.textContent = '';
    fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw new Error(b.error || 'HTTP ' + r.status); return b; }); })
      .then(function (b) {
        form.querySelector('input[name=price]').value = '';
        form.querySelector('input[name=listings]').value = '';
        form.querySelector('input[name=observedAt]').value = '';
        closeLog();
        $('resultCount').textContent = 'Saved — ' + b.points + ' observation(s) for this player.';
        schedule(0);
      })
      .catch(function (e) { err.textContent = e.message === 'Failed to fetch' ? 'Backend unreachable.' : e.message; })
      .then(function () { $('logSubmit').disabled = false; });
  }

  // ---------- wiring ----------
  function onFilterChange(e) {
    $('fConfOut').textContent = $('fConf').value;
    saveFilters();
    if (e && e.target.id === 'fHorizon') computeForecasts();
    if (state.mode !== null) { renderKpis(); renderGrid(); }
  }

  function init() {
    loadFilters();
    filterIds.forEach(function (id) { $(id).addEventListener(id === 'fSearch' || id === 'fConf' ? 'input' : 'change', onFilterChange); });
    ['fMin', 'fMax'].forEach(function (id) { $(id).addEventListener('input', onFilterChange); });
    $('pauseBtn').addEventListener('click', function () {
      state.paused = !state.paused;
      this.textContent = state.paused ? 'Resume' : 'Pause';
      this.setAttribute('aria-pressed', String(state.paused));
      if (state.paused) schedule(); else schedule(0);
      renderStatus();
    });
    $('logBtn').addEventListener('click', openLog);
    $('logCancel').addEventListener('click', closeLog);
    $('logForm').addEventListener('submit', submitLog);
    $('logForm').querySelector('input[name=name]').addEventListener('change', function () {
      var v = this.value.trim().toLowerCase();
      var p = state.players.filter(function (x) { return x.name.toLowerCase() === v; })[0];
      if (!p) return;
      var f = $('logForm');
      if (p.rating) f.querySelector('input[name=rating]').value = p.rating;
      f.querySelector('input[name=position]').value = p.position;
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) schedule();
      else if (!state.inflight) schedule(state.lastAttemptAt && Date.now() - state.lastAttemptAt < POLL_MS ? POLL_MS - (Date.now() - state.lastAttemptAt) : 0);
    });
    setInterval(tickMeta, 1000);
    renderGrid();
    poll();
  }

  // Exposed for automated QA only.
  window.__fmr = { state: state, poll: poll };
  init();
})();
