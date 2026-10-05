/* global window, document, navigator, fetch, setTimeout, setInterval, confirm */
'use strict';
(function () {
  var API = (typeof window.LATERAL_ADMIN_API === 'string' && window.LATERAL_ADMIN_API) || 'api/';
  var $ = function (id) { return document.getElementById(id); };
  var state = { mode: 'name', items: [], catalog: [], picked: [], limits: { marks: 100000, items: 20, message: 140 }, publicUrl: '' };
  var GATE = 'Sign in to NordDrop as admin, then reload this page.';

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function when(ms) { if (!ms) return '-'; var d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function banner(text, bad) { var b = $('banner'); if (!text) { b.hidden = true; return; } b.textContent = text; b.className = 'banner' + (bad ? ' bad' : ''); b.hidden = false; }

  // One place for every call. Anything that is not our JSON (a login page, a redirect, a gate error) reads as "sign in again".
  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', redirect: 'manual', headers: { 'Accept': 'application/json' } };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-Lateral-Admin'] = '1'; opts.body = JSON.stringify(body || {}); }
    return fetch(API + path, opts).then(function (res) {
      if (res.type === 'opaqueredirect' || res.status === 0) throw { gate: true };
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('application/json') !== 0) throw { gate: true };
      return res.json().then(function (data) {
        if (res.status === 401) throw { gate: true };
        if (!res.ok) throw { message: data.message || data.error || ('Error ' + res.status), code: data.error, status: res.status };
        return data;
      });
    }, function () { throw { gate: true }; });
  }
  function fail(e) {
    if (e && e.gate) banner(GATE, true);
    else banner((e && e.message) || 'Something went wrong.', true);
  }

  /* ---------------------------------------------------------------- stats */
  function loadStats() {
    return api('GET', 'stats').then(function (s) {
      banner('');
      var box = $('stats'); box.textContent = '';
      [['Online', s.online], ['Accounts', s.accounts], ['Lobbies', s.lobbies], ['Msgs/s', s.inPerSec], ['Review', s.flags]].forEach(function (p) {
        box.appendChild(el('div', { class: 'stat' }, [el('b', { text: fmt(p[1]) }), el('span', { text: p[0] })]));
      });
      $('flagsCard').hidden = !s.flags;
      if (s.flags) loadFlags();
    }).catch(fail);
  }
  function loadFlags() {
    api('GET', 'flags').then(function (d) {
      var tb = $('flagTable').querySelector('tbody'); tb.textContent = '';
      d.flags.forEach(function (f) { tb.appendChild(el('tr', null, [el('td', { text: when(f.ts) }), el('td', { text: f.account_id }), el('td', { text: f.kind }), el('td', { text: f.detail })])); });
    }).catch(function () {});
  }

  /* ---------------------------------------------------------------- the form */
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.mode === mode)); });
    $('fName').hidden = mode !== 'name'; $('fEmail').hidden = mode !== 'email'; $('fMax').hidden = mode !== 'link';
    $('sendBtn').textContent = mode === 'name' ? 'Send gift' : mode === 'email' ? 'Make link and email' : 'Make link';
    $('result').hidden = true; renderPreview();
  }
  function loadCatalog() {
    return api('GET', 'catalog').then(function (d) { state.catalog = d.items; state.limits = d.limits; $('marks').max = d.limits.marks; renderItems(); }).catch(fail);
  }
  function renderItems() {
    var q = $('itemSearch').value.trim().toLowerCase(), box = $('itemList'); box.textContent = '';
    var shown = 0;
    state.catalog.forEach(function (it) {
      if (shown >= 40 || state.picked.indexOf(it.id) >= 0) return;
      if (q && (it.name + ' ' + it.id + ' ' + it.slot + ' ' + it.rarity).toLowerCase().indexOf(q) < 0) return;
      shown++;
      var row = el('div', { class: 'item', role: 'option', tabindex: '0' }, [el('span', { text: it.name }), el('small', { text: it.slot + ' / ' + it.rarity + ' / ' + fmt(it.price) + ' M' })]);
      var add = function () { if (state.picked.length < state.limits.items) { state.picked.push(it.id); renderItems(); renderPicked(); renderPreview(); } };
      row.addEventListener('click', add); row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } });
      box.appendChild(row);
    });
    if (!shown) box.appendChild(el('div', { class: 'item muted', text: 'No match' }));
  }
  function nameOf(id) { for (var i = 0; i < state.catalog.length; i++) if (state.catalog[i].id === id) return state.catalog[i].name; return id; }
  function renderPicked() {
    var box = $('picked'); box.textContent = '';
    state.picked.forEach(function (id) {
      var x = el('button', { type: 'button', 'aria-label': 'Remove ' + nameOf(id), text: 'x' });
      x.addEventListener('click', function () { state.picked = state.picked.filter(function (p) { return p !== id; }); renderItems(); renderPicked(); renderPreview(); });
      box.appendChild(el('span', { class: 'chip' }, [nameOf(id), x]));
    });
  }
  function marks() { var n = Math.floor(Number($('marks').value)); return isFinite(n) && n > 0 ? n : 0; }
  function renderPreview() {
    var box = $('preview'); box.textContent = '';
    var m = marks(), items = state.picked.length, msg = $('message').value.trim();
    $('count').textContent = $('message').value.length + ' / 140';
    var what = [];
    if (m) what.push(fmt(m) + ' Marks');
    if (items) what.push(items === 1 ? nameOf(state.picked[0]) : items + ' items');
    box.appendChild(el('div', { class: 'muted', text: 'What they will see' }));
    box.appendChild(el('div', null, [el('strong', { text: 'A gift from Louis' })]));
    if (msg) box.appendChild(el('div', { class: 'msg', text: '"' + msg + '"' }));
    box.appendChild(el('div', { text: what.length ? what.join(' and ') : 'Nothing inside yet' }));
  }
  function body() {
    var b = { marks: marks(), items: state.picked.slice(), message: $('message').value.trim() };
    var days = $('expiry').value; if (days) b.expiresInDays = Number(days);
    if (state.mode === 'name') b.to = $('to').value.trim();
    else if (state.mode === 'email') b.email = $('email').value.trim();
    else { b.code = true; b.maxClaims = Math.max(1, Math.floor(Number($('maxClaims').value)) || 1); }
    return b;
  }
  function describe(b) {
    var parts = [];
    if (b.marks) parts.push(fmt(b.marks) + ' Marks');
    if (b.items.length) parts.push(b.items.length + (b.items.length === 1 ? ' item' : ' items'));
    var what = parts.join(' and ');
    if (b.to) return 'Send ' + what + ' to ' + b.to + '?';
    if (b.email) return 'Make a one-time link with ' + what + (state.emailOn ? ' and email it?' : '? (Email sending is off, you will get the link and message to send yourself.)');
    return 'Make a link with ' + what + ' that ' + b.maxClaims + (b.maxClaims === 1 ? ' person' : ' people') + ' can open?';
  }

  var pending = null;
  $('giftForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var b = body();
    if (!b.marks && !b.items.length) { banner('Add some Marks or at least one item.', true); return; }
    if (state.mode === 'name' && !b.to) { banner('Type a driver name.', true); return; }
    if (state.mode === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) { banner('That does not look like an email address.', true); return; }
    banner(''); pending = b;
    $('confirmText').textContent = describe(b); $('confirm').hidden = false; $('result').hidden = true;
    $('confirmYes').focus();
  });
  $('confirmNo').addEventListener('click', function () { pending = null; $('confirm').hidden = true; });
  $('confirmYes').addEventListener('click', function () {
    if (!pending) return;
    var b = pending; pending = null; $('confirm').hidden = true; $('sendBtn').disabled = true;
    api('POST', 'gift', b).then(function (r) { showResult(r, b); loadGifts(); loadStats(); }).catch(fail).then(function () { $('sendBtn').disabled = false; });
  });

  function copy(text, btn) {
    var done = function () { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) { var t = el('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch { /* ignore */ } document.body.removeChild(t); }

  function showResult(r, b) {
    var box = $('result'); box.textContent = '';
    if (r.kind === 'direct') {
      box.appendChild(el('strong', { text: 'Sent to ' + r.gift.toName + '.' }));
      box.appendChild(el('p', { class: 'muted', text: 'It shows up in their game right away.' }));
    } else if (r.kind === 'all') {
      box.appendChild(el('strong', { text: 'Sent to ' + r.count + ' drivers.' }));
    } else {
      var status = r.kind === 'email' ? (r.emailStatus === 'sent' ? 'Email sent.' : r.emailStatus === 'failed' ? 'The email did not go out. Send the message yourself.' : 'Email sending is off. Send the message yourself.') : 'Link ready.';
      box.appendChild(el('strong', { text: status }));
      box.appendChild(el('pre', { text: r.link }));
      var text = r.message ? r.message.text : r.link;
      box.appendChild(el('div', { class: 'muted', text: 'Message to send' }));
      box.appendChild(el('pre', { text: text }));
      var row = el('div', { class: 'row' });
      var c1 = el('button', { type: 'button', text: 'Copy link' }); c1.addEventListener('click', function () { copy(r.link, c1); });
      var c2 = el('button', { type: 'button', text: 'Copy message' }); c2.addEventListener('click', function () { copy(text, c2); });
      row.appendChild(c1); row.appendChild(c2);
      if (b.email) {
        var subject = r.message ? r.message.subject : 'A gift in LATERAL';
        row.appendChild(el('a', { class: 'btn', href: 'mailto:' + encodeURIComponent(b.email).replace('%40', '@') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text), text: 'Open in Mail' }));
      }
      box.appendChild(row);
    }
    box.hidden = false;
  }

  /* ---------------------------------------------------------------- recent gifts */
  function loadGifts() {
    return api('GET', 'gifts?limit=40').then(function (d) {
      var tb = $('giftTable').querySelector('tbody'); tb.textContent = '';
      d.gifts.forEach(function (g) {
        var to = g.toName || g.emailMasked || (g.kind === 'code' ? 'link' : '-');
        var what = (g.marks ? fmt(g.marks) + ' M' : '') + (g.items.length ? (g.marks ? ' + ' : '') + g.items.length + ' item' + (g.items.length > 1 ? 's' : '') : '');
        var act = el('td');
        if (g.link) { var c = el('button', { type: 'button', text: 'Copy link' }); c.addEventListener('click', function () { copy(g.link, c); }); act.appendChild(c); act.appendChild(document.createTextNode(' ')); }
        if (g.state === 'open') { var r = el('button', { type: 'button', class: 'danger', text: 'Revoke' }); r.addEventListener('click', function () { if (confirm('Take this gift back?')) api('POST', 'gift/' + encodeURIComponent(g.id) + '/revoke', {}).then(loadGifts).catch(fail); }); act.appendChild(r); }
        var claimed = g.kind === 'code' ? (g.claims + ' / ' + g.maxClaims + (g.claimedBy.length ? ': ' + g.claimedBy.join(', ') : '')) : (g.claimedBy.join(', ') || '-');
        tb.appendChild(el('tr', null, [el('td', { text: when(g.createdAt) }), el('td', { text: to }), el('td', { text: what }), el('td', null, [el('span', { class: 'pill ' + g.state, text: g.state })]), el('td', { text: claimed }), act]));
      });
      if (!d.gifts.length) tb.appendChild(el('tr', null, [el('td', { class: 'muted', colspan: '6', text: 'No gifts yet.' })]));
    }).catch(fail);
  }

  /* ---------------------------------------------------------------- accounts */
  function search(q) {
    return api('GET', 'accounts?q=' + encodeURIComponent(q)).then(function (d) {
      var tb = $('accTable').querySelector('tbody'); tb.textContent = '';
      d.accounts.forEach(function (a) {
        var tags = []; if (a.admin) tags.push('admin'); if (a.banned) tags.push('banned');
        var open = el('button', { type: 'button', text: 'Ledger' }); open.addEventListener('click', function () { ledger(a.name); });
        var ban = el('button', { type: 'button', class: a.banned ? '' : 'danger', text: a.banned ? 'Unban' : 'Ban' });
        ban.addEventListener('click', function () {
          if (!a.banned && !confirm('Ban ' + a.name + '? They are disconnected at once.')) return;
          api('POST', 'account/' + encodeURIComponent(a.name) + '/' + (a.banned ? 'unban' : 'ban'), a.banned ? {} : { reason: 'admin page' }).then(function () { search($('q').value.trim()); }).catch(fail);
        });
        var act = el('td', null, [open, document.createTextNode(' '), ban]);
        tb.appendChild(el('tr', null, [el('td', { text: a.name }), el('td', { text: when(a.lastSeen) }), el('td', null, tags.map(function (t) { return el('span', { class: 'pill ' + (t === 'banned' ? 'banned' : ''), text: t }); })), act]));
      });
      if (!d.accounts.length) tb.appendChild(el('tr', null, [el('td', { class: 'muted', colspan: '4', text: 'No accounts match.' })]));
    }).catch(fail);
  }
  function ledger(name) {
    api('GET', 'ledger?name=' + encodeURIComponent(name)).then(function (d) {
      $('ledgerBox').hidden = false;
      $('ledgerTitle').textContent = d.account.name + ': balance ' + (d.balance === null ? 'no wallet yet' : fmt(d.balance) + ' Marks') + ', ' + d.owned.length + ' items owned';
      var tb = $('ledgerTable').querySelector('tbody'); tb.textContent = '';
      d.ledger.forEach(function (l) { tb.appendChild(el('tr', null, [el('td', { text: when(l.ts) }), el('td', { text: l.kind }), el('td', { class: 'num', text: fmt(l.amount) }), el('td', { text: l.ref })])); });
      if (!d.ledger.length) tb.appendChild(el('tr', null, [el('td', { class: 'muted', colspan: '4', text: 'Nothing yet.' })]));
    }).catch(fail);
  }

  /* ---------------------------------------------------------------- wire up */
  document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { setMode(b.dataset.mode); }); });
  ['marks', 'message', 'to', 'email'].forEach(function (id) { $(id).addEventListener('input', renderPreview); });
  $('itemSearch').addEventListener('input', renderItems);
  $('lookupForm').addEventListener('submit', function (e) { e.preventDefault(); search($('q').value.trim()); });
  setMode('name'); renderPreview();
  api('GET', 'whoami').then(function (w) { state.emailOn = w.emailEnabled; state.publicUrl = w.publicUrl; }).catch(fail)
    .then(function () { return Promise.all([loadCatalog(), loadGifts(), loadStats(), search('')]); });
  setInterval(loadStats, 15000);
})();
