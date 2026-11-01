/* =====================================================================
   Nourah & Aziz — client
   The session token lives only in memory: refreshing or reopening the
   page always returns to the lock screen.
   ===================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const NAMES = { nourah: 'Nourah', aziz: 'Aziz' };

  const QUESTIONS = [
    {
      id: 'sleep', type: 'choice', title: 'Who put the other to sleep today?', short: 'Putting to sleep',
      options: { nourah: 'Nourah put Aziz to sleep.', aziz: 'Aziz put Nourah to sleep.' },
    },
    { id: 'kisses', type: 'count', title: 'How many kisses did we share today?' },
    {
      id: 'kissedMore', type: 'choice', title: 'Who kissed the other more today?', short: 'Kissed more',
      options: { nourah: 'Nourah kissed Aziz more.', aziz: 'Aziz kissed Nourah more.' },
    },
    {
      id: 'spoiled', type: 'choice', title: 'Who spoiled the other more today?', short: 'Spoiled more',
      options: { nourah: 'Nourah spoiled Aziz more.', aziz: 'Aziz spoiled Nourah more.' },
    },
    {
      id: 'affectionate', type: 'choice', title: 'Who was more affectionate today?', short: 'More affectionate',
      options: {
        nourah: 'Nourah was more affectionate toward Aziz.',
        aziz: 'Aziz was more affectionate toward Nourah.',
      },
    },
    {
      id: 'initiated', type: 'choice', title: 'Who initiated affection first today?', short: 'Initiated first',
      options: { nourah: 'Nourah initiated first.', aziz: 'Aziz initiated first.' },
    },
    { id: 'note', type: 'note', title: 'A little moment from today' },
  ];
  const CHOICES = QUESTIONS.filter((q) => q.type === 'choice');
  const TRACKED = QUESTIONS.filter((q) => q.type !== 'note'); // counts toward progress

  const CHECK_SVG =
    '<svg class="option__check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  let token = null;
  let entries = {};
  let currentDate = todayKey();
  let range = '30';
  let hiddenAt = 0;
  const AUTO_LOCK_HIDDEN_MS = 5 * 60 * 1000;

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */
  function pad(n) { return String(n).padStart(2, '0'); }
  function keyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayKey() { return keyOf(new Date()); }
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function shiftKey(k, days) { const d = parseKey(k); d.setDate(d.getDate() + days); return keyOf(d); }
  const fmtWeekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
  const fmtShortDow = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
  const fmtLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      cache: 'no-store',
      credentials: 'omit',
    });
    const renewed = res.headers.get('X-Session-Token');
    if (renewed && token) token = renewed;
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (res.status === 401 && token) {
      lock('Your session ended. Please unlock again.');
      throw new Error('unauthorized');
    }
    return { ok: res.ok, status: res.status, data };
  }

  /* ------------------------------------------------------------------ */
  /* Lock screen                                                         */
  /* ------------------------------------------------------------------ */
  const lockEl = $('#lock');
  const dotsEl = $('#dots');
  const dots = $$('.dot', dotsEl);
  const keypad = $('#keypad');
  const lockMsg = $('#lockMessage');
  let code = '';
  let busy = false;
  let cooldownTimer = null;

  function renderDots() {
    dots.forEach((d, i) => d.classList.toggle('is-filled', i < code.length));
    dotsEl.setAttribute('aria-label', `Passcode, ${code.length} of 6 digits entered`);
  }

  function setLockMessage(text, isError = false) {
    lockMsg.textContent = text;
    lockMsg.classList.toggle('is-error', isError);
  }

  function pressVisual(btn) {
    if (!btn) return;
    btn.classList.add('is-pressed');
    setTimeout(() => btn.classList.remove('is-pressed'), 140);
  }

  function input(key) {
    if (busy || keypad.classList.contains('is-disabled')) return;
    if (key === 'back') {
      code = code.slice(0, -1);
      renderDots();
      return;
    }
    if (!/^\d$/.test(key) || code.length >= 6) return;
    code += key;
    renderDots();
    if (navigator.vibrate) navigator.vibrate(8);
    if (code.length === 6) setTimeout(submit, 180);
  }

  async function submit() {
    busy = true;
    dotsEl.classList.add('is-checking');
    setLockMessage('');
    let res;
    try {
      res = await api('/api/unlock', { method: 'POST', body: JSON.stringify({ passcode: code }) });
    } catch (_) {
      res = { ok: false, status: 0, data: null };
    }
    dotsEl.classList.remove('is-checking');

    if (res.ok && res.data && res.data.token) {
      token = res.data.token;
      code = '';
      dotsEl.classList.add('is-success');
      setLockMessage('Welcome home');
      await unlockTransition();
      busy = false;
      return;
    }

    code = '';
    dotsEl.classList.add('is-error');
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    setTimeout(() => {
      dotsEl.classList.remove('is-error');
      renderDots();
      busy = false;
    }, 650);

    const wait = res.data && res.data.retryAfter;
    if (res.status === 0) setLockMessage('Can’t reach the server. Try again.', true);
    else if (wait) startCooldown(wait);
    else setLockMessage('That’s not quite it', true);
  }

  function startCooldown(seconds) {
    clearInterval(cooldownTimer);
    keypad.classList.add('is-disabled');
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(cooldownTimer);
        keypad.classList.remove('is-disabled');
        setLockMessage('Enter your passcode');
        return;
      }
      const m = Math.floor(left / 60);
      const s = left % 60;
      setLockMessage(`Too many tries — wait ${m ? `${m}m ` : ''}${s}s`, true);
      left -= 1;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  keypad.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-key]');
    if (!btn) return;
    e.preventDefault();
    pressVisual(btn);
    input(btn.dataset.key);
  });
  // keyboard activation of focused keys (Enter / Space)
  keypad.addEventListener('click', (e) => {
    if (e.detail !== 0) return; // pointer clicks handled above
    const btn = e.target.closest('[data-key]');
    if (btn) input(btn.dataset.key);
  });

  document.addEventListener('keydown', (e) => {
    if (token || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      pressVisual($(`.key[data-key="${e.key}"]`));
      input(e.key);
    } else if (e.key === 'Backspace') {
      pressVisual($('.key[data-key="back"]'));
      input('back');
    }
  });

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function unlockTransition() {
    let loaded = false;
    try {
      const res = await api('/api/entries');
      entries = (res.data && res.data.entries) || {};
      loaded = true;
    } catch (_) { /* handled by api() */ }
    if (!loaded || !token) return;

    currentDate = todayKey();
    renderToday(false);
    await wait(350);
    document.body.classList.add('is-unlocking');
    $('#app').hidden = false;
    requestAnimationFrame(() => {
      document.body.classList.add('is-open');
      positionGlider();
    });
    await wait(1100);
    lockEl.hidden = true;
    document.body.classList.remove('is-locked', 'is-unlocking');
    dotsEl.classList.remove('is-success');
    renderDots();
  }

  function lock(message) {
    const hadToken = !!token;
    if (hadToken) {
      // best effort: invalidate server session
      fetch('/api/lock', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
    }
    token = null;
    entries = {};
    code = '';
    busy = false;
    $('#questions').replaceChildren();
    $('#balance').replaceChildren();
    $('#moments').replaceChildren();
    document.body.classList.remove('is-open', 'is-unlocking');
    document.body.classList.add('is-locked');
    $('#app').hidden = true;
    lockEl.hidden = false;
    // restart entrance animation
    const inner = $('.lock__inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.removeProperty('animation');
    renderDots();
    setLockMessage(message || 'Enter your passcode', !!message);
    showView('today', false);
  }

  $('#lockBtn').addEventListener('click', () => lock());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (token && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_HIDDEN_MS) lock();
  });

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */
  const tabs = $$('.tab');
  const glider = $('.tabs__glider');
  let activeView = 'today';

  function positionGlider() {
    const active = $('.tab.is-active');
    if (!active) return;
    glider.style.width = `${active.offsetWidth}px`;
    glider.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  function showView(name, scroll = true) {
    activeView = name;
    tabs.forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $$('.view').forEach((v) => {
      const on = v.dataset.view === name;
      v.hidden = !on;
      v.classList.toggle('is-active', on);
    });
    positionGlider();
    if (name === 'balance') renderBalance();
    if (name === 'moments') renderMoments();
    if (name === 'today') renderToday(false);
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  tabs.forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  window.addEventListener('resize', positionGlider);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionGlider);

  /* ------------------------------------------------------------------ */
  /* Saving                                                              */
  /* ------------------------------------------------------------------ */
  const saveState = $('#saveState');
  let saveHideTimer = null;
  const pending = new Map(); // date -> patch
  const timers = new Map();

  function showSave(state) {
    clearTimeout(saveHideTimer);
    saveState.classList.remove('is-saving', 'is-error');
    saveState.classList.add('is-visible');
    if (state === 'saving') { saveState.classList.add('is-saving'); saveState.textContent = 'Saving'; }
    else if (state === 'error') { saveState.classList.add('is-error'); saveState.textContent = 'Not saved'; }
    else {
      saveState.textContent = 'Saved';
      saveHideTimer = setTimeout(() => saveState.classList.remove('is-visible'), 1800);
    }
  }

  function queueSave(date, patch, delay = 0) {
    const local = { ...(entries[date] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') delete local[k];
      else local[k] = v;
    }
    entries[date] = local;

    pending.set(date, { ...(pending.get(date) || {}), ...patch });
    clearTimeout(timers.get(date));
    showSave('saving');
    timers.set(date, setTimeout(() => flush(date), delay));
  }

  async function flush(date) {
    const patch = pending.get(date);
    if (!patch) return;
    pending.delete(date);
    try {
      const res = await api(`/api/entries/${date}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) throw new Error('save failed');
      showSave('saved');
    } catch (e) {
      if (!token) return;
      showSave('error');
      toast('Couldn’t save that — check your connection.');
      // put it back so the next change retries it
      pending.set(date, { ...patch, ...(pending.get(date) || {}) });
    }
  }

  window.addEventListener('beforeunload', () => {
    for (const date of pending.keys()) {
      fetch(`/api/entries/${date}`, {
        method: 'PATCH',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(pending.get(date)),
      }).catch(() => {});
    }
  });

  /* ------------------------------------------------------------------ */
  /* Today                                                               */
  /* ------------------------------------------------------------------ */
  const questionsEl = $('#questions');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildCard(q, i, entry) {
    const card = document.createElement('article');
    card.className = 'card';
    card.style.setProperty('--i', i);
    card.dataset.q = q.id;
    const num = q.type === 'note' ? '—' : pad(i + 1);
    card.innerHTML = `<header class="card__head"><span class="card__num">${num}</span><h3 class="card__q">${escapeHtml(q.title)}</h3></header>`;

    if (q.type === 'choice') {
      const opts = document.createElement('div');
      opts.className = 'options';
      opts.setAttribute('role', 'radiogroup');
      opts.setAttribute('aria-label', q.title);
      for (const who of ['nourah', 'aziz']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `option option--${who}`;
        b.dataset.who = who;
        b.setAttribute('role', 'radio');
        b.innerHTML = `<span class="avatar avatar--${who}">${NAMES[who][0]}</span><span class="option__text">${escapeHtml(q.options[who])}</span>${CHECK_SVG}`;
        b.addEventListener('click', () => {
          const cur = (entries[currentDate] || {})[q.id];
          const next = cur === who ? null : who;
          queueSave(currentDate, { [q.id]: next });
          paintChoice(card, next);
          updateMeta();
          if (next && navigator.vibrate) navigator.vibrate(6);
        });
        opts.appendChild(b);
      }
      card.appendChild(opts);
      paintChoice(card, entry[q.id] || null);
    } else if (q.type === 'count') {
      const wrap = document.createElement('div');
      wrap.className = 'counter';
      wrap.innerHTML = `
        <button class="counter__btn" type="button" data-step="-1" aria-label="One fewer">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <label class="counter__value">
          <input class="counter__input" type="number" inputmode="numeric" min="0" max="9999" placeholder="0" aria-label="Number of kisses" />
          <span class="counter__label">kisses shared</span>
        </label>
        <button class="counter__btn" type="button" data-step="1" aria-label="One more">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 12h12M12 6v12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>`;
      const inputEl = $('.counter__input', wrap);
      const setVal = (v) => {
        inputEl.value = v == null ? '' : String(v);
        sizeInput(inputEl);
      };
      setVal(entry.kisses);
      $$('.counter__btn', wrap).forEach((btn) => {
        let holdTimer = null;
        let repeatTimer = null;
        const step = () => {
          const k = (entries[currentDate] || {}).kisses;
          const has = Number.isInteger(k);
          if (!has && btn.dataset.step === '-1') return;
          const next = Math.max(0, Math.min(9999, (has ? k : 0) + Number(btn.dataset.step)));
          setVal(next);
          bump(inputEl);
          queueSave(currentDate, { kisses: next }, 500);
          updateMeta();
        };
        const stop = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); };
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          step();
          holdTimer = setTimeout(() => { repeatTimer = setInterval(step, 90); }, 450);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
        btn.addEventListener('click', (e) => { if (e.detail === 0) step(); });
      });
      inputEl.addEventListener('input', () => {
        let v = inputEl.value.replace(/\D/g, '').slice(0, 4);
        if (inputEl.value !== v) inputEl.value = v;
        sizeInput(inputEl);
        queueSave(currentDate, { kisses: v === '' ? null : Number(v) }, 700);
        updateMeta();
      });
      card.appendChild(wrap);
    } else if (q.type === 'note') {
      card.classList.add('card--wide');
      const ta = document.createElement('textarea');
      ta.className = 'note';
      ta.maxLength = 1000;
      ta.rows = 3;
      ta.placeholder = 'Something small and sweet you want to remember…';
      ta.value = entry.note || '';
      const hint = document.createElement('p');
      hint.className = 'card__hint';
      hint.textContent = 'Optional';
      ta.addEventListener('input', () => {
        queueSave(currentDate, { note: ta.value.trim() ? ta.value : null }, 900);
      });
      card.append(ta, hint);
    }
    return card;
  }

  function sizeInput(el) {
    el.style.width = `${Math.max(1, (el.value || el.placeholder).length) + 0.6}ch`;
  }

  function bump(el) {
    el.classList.remove('is-bump');
    void el.offsetWidth;
    el.classList.add('is-bump');
  }

  function paintChoice(card, who) {
    const opts = $('.options', card);
    opts.classList.toggle('has-choice', !!who);
    $$('.option', card).forEach((b) => {
      const on = b.dataset.who === who;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    if (who) card.dataset.winner = who;
    else delete card.dataset.winner;
  }

  function renderToday(animateTitle = true) {
    if (!token) return;
    const entry = entries[currentDate] || {};
    const d = parseKey(currentDate);
    const today = todayKey();
    const diff = Math.round((parseKey(today) - d) / 86400000);

    $('#dayEyebrow').textContent = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff > 1 ? `${diff} days ago` : 'Ahead';
    const title = $('#dayTitle');
    title.textContent = fmtWeekday.format(d);
    if (animateTitle) { title.classList.remove('is-changing'); void title.offsetWidth; title.classList.add('is-changing'); }
    $('#daySub').textContent = fmtLong.format(d);
    $('#nextDay').disabled = currentDate >= today;
    $('#goToday').hidden = currentDate === today;

    questionsEl.replaceChildren(...QUESTIONS.map((q, i) => buildCard(q, i, entry)));
    $$('.counter__input', questionsEl).forEach(sizeInput);
    updateMeta();
  }

  function answeredCount(entry) {
    return TRACKED.filter((q) => entry[q.id] !== undefined && entry[q.id] !== null).length;
  }

  function updateMeta() {
    const entry = entries[currentDate] || {};
    const n = answeredCount(entry);
    const total = TRACKED.length;
    const C = 106.8;
    $('#progressBar').style.strokeDashoffset = String(C - (C * n) / total);
    $('.progress').classList.toggle('is-complete', n === total);
    $('#progressText').textContent =
      n === 0 ? 'Nothing written yet' : n === total ? 'All written down' : `${n} of ${total} answered`;

    // Verdict for the day
    const verdict = $('#dayVerdict');
    let nn = 0;
    let aa = 0;
    for (const q of CHOICES) {
      if (entry[q.id] === 'nourah') nn += 1;
      if (entry[q.id] === 'aziz') aa += 1;
    }
    if (nn + aa < 2) { verdict.hidden = true; return; }
    verdict.hidden = false;
    const when = currentDate === todayKey() ? 'Today' : 'This day';
    if (nn === aa) verdict.innerHTML = `${when} was perfectly even — <b class="c-rose">${nn}</b> to <b class="c-sky">${aa}</b>.`;
    else if (nn > aa) verdict.innerHTML = `${when} leaned towards <b class="c-rose">Nourah</b> — ${nn} to ${aa}.`;
    else verdict.innerHTML = `${when} leaned towards <b class="c-sky">Aziz</b> — ${aa} to ${nn}.`;
  }

  function goTo(date) {
    if (date > todayKey()) return;
    if (pending.has(currentDate)) { clearTimeout(timers.get(currentDate)); flush(currentDate); }
    currentDate = date;
    renderToday();
  }

  $('#prevDay').addEventListener('click', () => goTo(shiftKey(currentDate, -1)));
  $('#nextDay').addEventListener('click', () => goTo(shiftKey(currentDate, 1)));
  $('#goToday').addEventListener('click', () => goTo(todayKey()));

  // swipe between days on touch devices
  let touchX = null;
  let touchY = null;
  const hero = $('.day-hero');
  hero.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
  hero.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) goTo(shiftKey(currentDate, dx > 0 ? -1 : 1));
  });

  /* ------------------------------------------------------------------ */
  /* Balance                                                             */
  /* ------------------------------------------------------------------ */
  function entriesInRange() {
    const keys = Object.keys(entries).filter((k) => answeredCount(entries[k]) > 0 || entries[k].note).sort();
    if (range === 'all') return keys;
    const from = shiftKey(todayKey(), -(Number(range) - 1));
    return keys.filter((k) => k >= from);
  }

  function streak() {
    let s = 0;
    let k = todayKey();
    if (!entries[k] || answeredCount(entries[k]) === 0) k = shiftKey(k, -1);
    while (entries[k] && answeredCount(entries[k]) > 0) { s += 1; k = shiftKey(k, -1); }
    return s;
  }

  function split(n, a) {
    const el = document.createElement('div');
    el.className = 'split';
    el.innerHTML = '<span class="split__n"></span><span class="split__a"></span>';
    const [sn, sa] = el.children;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      sn.style.flexGrow = String(n || (a ? 0 : 1));
      sa.style.flexGrow = String(a || (n ? 0 : 1));
      if (!n && !a) { sn.style.opacity = '0.15'; sa.style.opacity = '0.15'; }
      else if (!n) sn.hidden = true;
      else if (!a) sa.hidden = true;
    }));
    return el;
  }

  function renderBalance() {
    const root = $('#balance');
    const keys = entriesInRange();
    if (!keys.length) {
      root.innerHTML = '<div class="card empty">Nothing here yet. Start with today.</div>';
      return;
    }

    let totalN = 0;
    let totalA = 0;
    let kisses = 0;
    let kissDays = 0;
    let bestKiss = 0;
    const perCat = Object.fromEntries(CHOICES.map((q) => [q.id, { nourah: 0, aziz: 0 }]));
    for (const k of keys) {
      const e = entries[k];
      for (const q of CHOICES) {
        if (e[q.id] === 'nourah') { perCat[q.id].nourah += 1; totalN += 1; }
        if (e[q.id] === 'aziz') { perCat[q.id].aziz += 1; totalA += 1; }
      }
      if (Number.isInteger(e.kisses)) {
        kisses += e.kisses; kissDays += 1; bestKiss = Math.max(bestKiss, e.kisses);
      }
    }

    const caption =
      totalN === totalA ? 'Perfectly balanced, as it should be.'
        : totalN > totalA ? 'Nourah is ahead — for now.'
          : 'Aziz is ahead — for now.';

    const board = document.createElement('div');
    board.className = 'card scoreboard';
    board.innerHTML = `
      <div class="score score--nourah"><span class="score__name">Nourah</span><span class="score__value">${totalN}</span><span class="score__sub">moments</span></div>
      <span class="score-vs">&amp;</span>
      <div class="score score--aziz"><span class="score__name">Aziz</span><span class="score__value">${totalA}</span><span class="score__sub">moments</span></div>`;
    board.appendChild(split(totalN, totalA));
    const cap = document.createElement('p');
    cap.className = 'score-caption';
    cap.textContent = caption;
    board.appendChild(cap);
    board.dataset.winner = totalN > totalA ? 'nourah' : totalA > totalN ? 'aziz' : '';

    const stats = document.createElement('div');
    stats.className = 'stats';
    const statData = [
      [kisses.toLocaleString('en-GB'), 'kisses shared'],
      [kissDays ? String(Math.round((kisses / kissDays) * 10) / 10) : '—', 'kisses a day'],
      [keys.length, keys.length === 1 ? 'day kept' : 'days kept'],
      [streak(), 'day streak'],
    ];
    statData.forEach(([v, l], i) => {
      const s = document.createElement('div');
      s.className = 'card stat';
      s.style.setProperty('--i', i + 1);
      s.innerHTML = `<span class="stat__value">${v}</span><span class="stat__label">${l}</span>`;
      stats.appendChild(s);
    });

    const list = document.createElement('div');
    list.className = 'card cat-list';
    list.style.setProperty('--i', 5);
    for (const q of CHOICES) {
      const c = perCat[q.id];
      const row = document.createElement('div');
      row.className = 'cat';
      const leader = c.nourah === c.aziz ? (c.nourah ? 'Tied' : 'No answers yet') : c.nourah > c.aziz ? 'Nourah leads' : 'Aziz leads';
      row.innerHTML = `
        <div class="cat__top">
          <span class="cat__title">${q.short}</span>
          <span class="cat__nums"><b class="n">${c.nourah}</b> · <b class="a">${c.aziz}</b></span>
        </div>`;
      row.appendChild(split(c.nourah, c.aziz));
      const l = document.createElement('span');
      l.className = 'cat__leader';
      l.textContent = leader;
      row.appendChild(l);
      list.appendChild(row);
    }

    const best = document.createElement('p');
    best.className = 'day-verdict';
    best.textContent = bestKiss ? `Most kisses in a single day: ${bestKiss}.` : '';

    root.replaceChildren(board, stats, list, best);
  }

  $$('#rangeSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      range = b.dataset.range;
      $$('#rangeSeg button').forEach((x) => {
        x.classList.toggle('is-active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      renderBalance();
    }),
  );

  /* ------------------------------------------------------------------ */
  /* Moments                                                             */
  /* ------------------------------------------------------------------ */
  function renderMoments() {
    const root = $('#moments');
    const keys = Object.keys(entries).filter((k) => answeredCount(entries[k]) > 0 || entries[k].note).sort().reverse();
    if (!keys.length) {
      root.innerHTML = '<div class="card empty">Your days will gather here, one by one.</div>';
      return;
    }
    const nodes = [];
    let lastMonth = '';
    keys.forEach((k, i) => {
      const e = entries[k];
      const d = parseKey(k);
      const month = fmtMonth.format(d);
      if (month !== lastMonth) {
        const lbl = document.createElement('p');
        lbl.className = 'month-label';
        lbl.textContent = month;
        nodes.push(lbl);
        lastMonth = month;
      }
      let nn = 0;
      let aa = 0;
      const marks = CHOICES.map((q) => {
        if (e[q.id] === 'nourah') nn += 1;
        if (e[q.id] === 'aziz') aa += 1;
        return `<span class="mark ${e[q.id] ? `mark--${e[q.id]}` : ''}" title="${q.short}: ${e[q.id] ? NAMES[e[q.id]] : '—'}"></span>`;
      }).join('');
      const summary = nn + aa === 0 ? 'A quiet day' : nn === aa ? `Even, ${nn} to ${aa}` : nn > aa ? `Nourah's day, ${nn} to ${aa}` : `Aziz's day, ${aa} to ${nn}`;

      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'card moment';
      b.style.setProperty('--i', Math.min(i, 10));
      if (nn !== aa) b.dataset.winner = nn > aa ? 'nourah' : 'aziz';
      b.innerHTML = `
        <span class="moment__date"><span class="moment__day">${d.getDate()}</span><span class="moment__dow">${fmtShortDow.format(d)}</span></span>
        <span class="moment__body">
          <span class="moment__marks">${marks}</span>
          ${e.note ? `<p class="moment__note">“${escapeHtml(e.note)}”</p>` : `<p class="moment__summary">${summary}</p>`}
        </span>
        <span class="moment__kisses"><b>${Number.isInteger(e.kisses) ? e.kisses : '—'}</b><span>kisses</span></span>`;
      b.addEventListener('click', () => {
        currentDate = k;
        showView('today');
      });
      nodes.push(b);
    });
    root.replaceChildren(...nodes);
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2800);
  }

  // Keep "today" correct if the app stays open past midnight
  setInterval(() => {
    if (token && activeView === 'today') {
      const t = todayKey();
      $('#nextDay').disabled = currentDate >= t;
      $('#goToday').hidden = currentDate === t;
    }
  }, 60 * 1000);

  renderDots();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
