(function(){
  // audio: starts on first user gesture; toggle via topbar button.
  let audio = null;
  let audioOn = false;
  const stateEl = document.getElementById('musicState');
  
  function setAudioState(on){
    audioOn = on;
    if (stateEl) stateEl.textContent = on ? 'on' : 'off';
    const toggle = document.getElementById('musicBtn');
    if (toggle) toggle.setAttribute('aria-pressed', String(on));
  }
  
  function ensureAudio(){
    if (!audio) {
      audio = new Audio('/assets/medieval.mp3');
      audio.loop = true;
      audio.volume = 0.18;
    }
    return audio;
  }
  
  async function startAudio(){
    try {
      const a = ensureAudio();
      await a.play();
      setAudioState(true);
    } catch (e) {
      if (stateEl) stateEl.textContent = 'unavailable';
      const toggle = document.getElementById('musicBtn');
      if (toggle) toggle.title = 'Audio unavailable or blocked. Activate music to retry.';
    }
  }
  
  function stopAudio(){
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setAudioState(false);
  }
  
  function toggleAudio(){
    if (audioOn) stopAudio();
    else startAudio();
  }
  
  const btn = document.getElementById('musicBtn');
  if (btn) {
    btn.addEventListener('click', toggleAudio);
    // Native button provides Enter / Space activation without double toggles.
  }
  
  // "almost autoplay": start on first click/tap anywhere.
  window.addEventListener('pointerdown', ()=>{ if (!audioOn) startAudio(); }, { once: true });

  // charts: lightweight trend lines from /history
  let chart = null;
  function ensureChart(){
    if (!window.Chart) return null;
    const el = document.getElementById('chart');
    if (!el) return null;
    if (chart) return chart;

    const ctx = el.getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'avg power %', data: [], borderColor: '#2dd4bf', tension: 0.25, pointRadius: 0 },
          { label: 'max temp c', data: [], borderColor: '#fb7185', borderDash: [5, 4], tension: 0.25, pointRadius: 0, yAxisID: 'y1' },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { min: 0, max: 100, grid: { color: 'rgba(34,48,65,.35)' }, ticks: { color: '#9fb1c1' } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#9fb1c1' } },
        },
      },
    });
    return chart;
  }

  async function pollHistory(){
    const state = document.getElementById('history-state');
    try {
      const r = await fetch('/history', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const hist = await r.json();
      const c = ensureChart();
      if (!c) { if (state) state.textContent = 'Chart unavailable · numerical data in zone table'; return; }
      if (state) state.textContent = hist.length ? 'Live · ' + hist.length + ' samples' : 'Waiting for samples';
      c.data.labels = hist.map(p => p.t_s);
      c.data.datasets[0].data = hist.map(p => p.avg_power_pct);
      c.data.datasets[1].data = hist.map(p => p.max_temp_c);
      c.update();
    } catch (e) {
      if (state) state.textContent = 'History unavailable · retrying automatically';
    }
  }
  pollHistory();
  setInterval(pollHistory, 1000);

  // fire theme: prefer scene.js status events; fallback to polling only when scene isn't active (e.g. webgl off).
  function applyHeatTheme(st){
    // fire theme: high power only (keep it simple and visible)
    const zones = (st && Array.isArray(st.zones)) ? st.zones : [];
    let mx = 0;
    for (const z of zones) {
      const p = (z && typeof z.power_pct === 'number') ? z.power_pct : 0;
      if (p > mx) mx = p;
    }
    const hot = mx >= 75;
    document.body.classList.toggle('temp-high', hot);
    window.dispatchEvent(new CustomEvent('reactor:telemetry', { detail: st }));
  }

  let lastStatusEventAt = 0;
  let fallbackTimer = null;

  async function fallbackPollOnce() {
    try {
      const r = await fetch('/status');
      if (!r.ok) return;
      const st = await r.json();
      applyHeatTheme(st);
    } catch (e) {}
  }

  function startFallbackPoll() {
    if (fallbackTimer) return;
    fallbackPollOnce();
    fallbackTimer = setInterval(() => {
      // stop fallback as soon as scene.js starts emitting events
      if (Date.now() - lastStatusEventAt < 1500) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
        return;
      }
      fallbackPollOnce();
    }, 1000);
  }

  window.addEventListener('reactor:status', (ev) => {
    lastStatusEventAt = Date.now();
    applyHeatTheme(ev.detail);
  });

  if (window.__reactorStatus) {
    lastStatusEventAt = Date.now();
    applyHeatTheme(window.__reactorStatus);
  }

  // if no scene status events arrived quickly, enable fallback polling.
  setTimeout(() => {
    if (Date.now() - lastStatusEventAt > 1500) startFallbackPoll();
  }, 1700);
  // Resume the existing fallback if a once-working scene stops publishing.
  setInterval(() => {
    if (Date.now() - lastStatusEventAt > 3000) startFallbackPoll();
  }, 3000);

  // Audit uses explicit UTC, consistent across operators and historic dates.
  function formatAuditTs(root){
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    const els = scope.querySelectorAll('.audit-log__ts');
    for (const el of els) {
      const raw = el.getAttribute('data-ts');
      const ts = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
      const d = new Date(ts * 1000);
      const valid = Number.isSafeInteger(ts) && Number.isFinite(d.getTime());
      const s = valid ? d.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unknown timestamp';
      if (el.textContent !== s) el.textContent = s;
      el.title = valid ? s : 'Missing or invalid source timestamp';
    }
  }

  formatAuditTs(document);
  document.body.addEventListener('htmx:afterSwap', (ev) => {
    const t = ev && ev.detail && ev.detail.target;
    if (t && t.id === 'audit') formatAuditTs(t);
  });
})();

(function controlRoomFeedback(){
  const connection = document.getElementById('connection');
  if (!connection) return;
  const msg = document.getElementById('msg');
  const sceneState = document.getElementById('scene-state');
  const failures = new Set();
  const pending = new Map();
  let lastTelemetry = 0;
  let noticeTimer;
  const notice = document.createElement('div');
  notice.className = 'command-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  document.body.appendChild(notice);
  function announce(text, state){
    msg.textContent = text;
    msg.dataset.state = state;
    notice.textContent = text;
    notice.dataset.state = state;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    if (state !== 'pending') noticeTimer = setTimeout(() => { notice.hidden = true; }, 7000);
  }
  function updateConnection(){
    const age = lastTelemetry ? Date.now() - lastTelemetry : Infinity;
    const stale = age > 4500;
    let text;
    let state;
    if (!navigator.onLine || (stale && lastTelemetry)) {
      state = 'offline'; text = 'Offline / stale · last values retained · retrying';
    } else if (!lastTelemetry) {
      state = 'waiting'; text = 'Waiting for telemetry · controls may be unavailable';
    } else if (failures.size) {
      state = 'degraded'; text = 'Partial connection · ' + [...failures].join(', ') + ' unavailable';
    } else {
      state = 'live'; text = 'Live telemetry · 1s refresh';
    }
    if (!window.htmx) { state = 'offline'; text = 'Controls unavailable · HTMX did not load. Reload to retry.'; }
    connection.dataset.state = state;
    if (connection.textContent !== text) connection.textContent = text;
    document.querySelector('.telemetry').setAttribute('aria-label', stale ? 'Plant telemetry, stale or not yet received' : 'Live plant telemetry');
  }
  window.addEventListener('reactor:telemetry', (ev) => {
    lastTelemetry = Date.now();
    const st = ev.detail || {};
    const metrics = {'thermal':'power_th_mw','electric':'power_el_mw','hot':'primary_t_hot_c','pressure':'primary_pressure_bar','rods':'control_rod_pct'};
    for (const [id, key] of Object.entries(metrics)) {
      document.getElementById('metric-' + id).textContent = typeof st[key] === 'number' && Number.isFinite(st[key]) ? String(st[key]) : '—';
    }
    updateConnection();
  });
  window.addEventListener('offline', updateConnection);
  window.addEventListener('online', updateConnection);
  setInterval(updateConnection, 1000);
  updateConnection();
  if (window.htmx) window.htmx.config.timeout = 8000;
  document.body.addEventListener('htmx:beforeRequest', (ev) => {
    const d = ev.detail;
    const el = d.elt;
    if (!el || !el.hasAttribute('hx-post')) return;
    if (pending.has(el)) { ev.preventDefault(); return; }
    if (!navigator.onLine) { ev.preventDefault(); announce('Offline · command not sent. Reconnect and retry.', 'error'); return; }
    const buttons = el.matches('button') ? [el] : [...el.querySelectorAll('button')];
    pending.set(el, buttons.map(b => [b, b.disabled]));
    buttons.forEach(b => { b.disabled = true; });
    el.setAttribute('aria-busy', 'true');
    const label = el.matches('form') ? el.getAttribute('hx-post').replace('/ui/', '').replaceAll('_', ' ') + ' · ' + [...new FormData(el)].map(([k,v]) => k + '=' + v).join(', ') : el.textContent.trim();
    announce('Sending ' + label.toLowerCase() + '…', 'pending');
  });
  document.body.addEventListener('htmx:afterRequest', (ev) => {
    const d = ev.detail;
    const el = d.elt;
    if (!el) return;
    if (el.hasAttribute('hx-get')) {
      const key = el.id || 'panel';
      if (d.successful) failures.delete(key); else failures.add(key);
      el.dataset.connection = d.successful ? 'live' : 'stale';
      updateConnection();
    }
    if (!pending.has(el)) return;
    for (const [button, disabled] of pending.get(el)) button.disabled = disabled;
    pending.delete(el);
    el.removeAttribute('aria-busy');
    if (d.successful) {
      // Use the real server response; never invent command success.
      const response = document.createElement('div');
      response.innerHTML = d.xhr.responseText;
      announce(response.textContent.trim() || 'Command response received.', 'success');
    } else {
      const code = d.xhr?.status;
      announce(code ? 'Command failed · HTTP ' + code + '. Check values and retry.' : 'Connection lost · command outcome unknown. Check telemetry / audit before retrying.', 'error');
    }
  });
  function annotateViews(){
    for (const id of ['view-primary', 'view-secondary']) {
      const button = document.getElementById(id);
      button.setAttribute('aria-pressed', String(button.classList.contains('is-active')));
    }
    const host = document.getElementById('three');
    sceneState.textContent = host.querySelector('canvas') ? 'Drag to orbit · scroll to zoom' : '3D unavailable · telemetry and controls remain available';
  }
  const viewObserver = new MutationObserver(annotateViews);
  for (const id of ['view-primary', 'view-secondary']) viewObserver.observe(document.getElementById(id), {attributes:true,attributeFilter:['class']});
  setTimeout(annotateViews, 2000);
})();

// Operator widgets: editable drafts are independent of confirmed telemetry.
(function compactControlState(){
  if (!document.getElementById('control-1')) return;
  let latest;
  const zoneInput = document.getElementById('control-1');
  // Keep each server-reported pump name and state together when wrapping.
  function formatPumpStates(){
    const fw = document.getElementById('fw');
    const match = fw.textContent.trim().match(/^fw: (\S+) mode: (\S+) \| a: (\S+) b: (\S+) c: (\S+)$/);
    if (!match) return; // Preserve unfamiliar server responses verbatim.
    fw.replaceChildren(...['A', 'B', 'C'].map((name, index) => {
      const state = document.createElement('span');
      state.className = 'pump-state';
      const label = document.createElement('b');
      label.textContent = name;
      state.append(label, document.createTextNode(' ' + match[index + 3]));
      return state;
    }));
    fw.title = 'Active pump ' + match[1].toUpperCase() + ' · ' + match[2];
  }
  formatPumpStates();
  document.body.addEventListener('htmx:afterSwap', ev => {
    if (ev.detail.target?.id === 'fw') formatPumpStates();
  });
  function render(){
    if (!latest) return;
    const zones = latest.zones || [];
    // Only reconcile changed mappings: never replace a focused select each poll.
    const mapping = JSON.stringify(zones.map(z => [z.id, z.name]));
    if (zoneInput.dataset.mapping !== mapping) {
      const selected = zoneInput.value;
      zoneInput.replaceChildren(...zones.map(z => new Option(z.name, String(z.id))));
      if (zones.some(z => String(z.id) === selected)) zoneInput.value = selected;
      zoneInput.dataset.mapping = mapping;
    }
    const zone = zones.find(z => String(z.id) === zoneInput.value);
    document.getElementById('zone-current').textContent = zone ? 'ACTUAL ' + zone.power_pct + '% / TARGET ' + zone.target_power_pct + '% · ' + zone.temp_c + '°C' : 'No live telemetry for zone ' + (zoneInput.value || '—');
    document.getElementById('auto-current').textContent = (latest.auto_enabled ? 'Auto' : 'Manual') + ' · setpoint ' + latest.auto_setpoint_power_pct + '% · rods ' + latest.control_rod_pct + '% inserted';
    document.getElementById('auto-on').setAttribute('aria-pressed', String(latest.auto_enabled === true));
    document.getElementById('auto-off').setAttribute('aria-pressed', String(latest.auto_enabled === false));
    document.getElementById('cooling-current').textContent = 'FW ' + latest.fw_mode + ' · ' + String(latest.fw_active).toUpperCase();
    document.querySelectorAll('[hx-post="/ui/fw_active"] button').forEach(b => b.setAttribute('aria-pressed', String(latest.fw_mode !== 'auto' && b.value === latest.fw_active)));
    document.querySelector('[hx-post="/ui/fw_auto"] button').setAttribute('aria-pressed', String(latest.fw_mode === 'auto'));
  }
  window.addEventListener('reactor:telemetry', ev => {latest = ev.detail; render();});
  zoneInput.addEventListener('input', render);
  document.querySelectorAll('input[data-exact]').forEach(range => {
    const exact = document.getElementById(range.dataset.exact);
    const paint = () => range.style.setProperty('--fill', range.value + '%');
    range.addEventListener('input', () => { exact.value = range.value; paint(); });
    exact.addEventListener('input', () => { if (exact.validity.valid && exact.value !== '') range.value = exact.value; paint(); });
    range.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); range.form.requestSubmit(); } });
    paint();
  });
  document.querySelectorAll('#controls form[hx-post]').forEach((form, index) => {
    const button = form.querySelector('button');
    const label = button.textContent;
    let submitted;
    const host = form.closest('.segmented') || form;
    const feedback = host.querySelector('.command-feedback') || document.createElement('div');
    feedback.className = 'command-feedback';
    feedback.id = 'command-feedback-' + index;
    feedback.setAttribute('role', 'status');
    feedback.textContent = '';
    host.appendChild(feedback);
    form.querySelectorAll('input,select').forEach(input => {
      const descriptions = new Set((input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
      descriptions.add('draft-help');
      descriptions.add(feedback.id);
      input.setAttribute('aria-describedby', [...descriptions].join(' '));
    });
    form.addEventListener('input', () => {
      form.dataset.dirty = 'true';
      const inFlight = form.getAttribute('aria-busy') === 'true';
      feedback.dataset.state = inFlight ? 'pending' : 'draft';
      feedback.textContent = inFlight ? 'Sending previous values · newer draft not sent' : 'Unsaved draft · not sent';
      button.textContent = label;
      button.title = 'Draft values · not applied';
    });
    form.addEventListener('htmx:beforeRequest', () => {
      submitted = JSON.stringify([...new FormData(form)]);
      feedback.dataset.state = navigator.onLine ? 'pending' : 'error';
      feedback.textContent = navigator.onLine ? 'Sending command…' : 'Offline · not sent. Reconnect and retry.';
    });
    form.addEventListener('htmx:afterRequest', ev => {
      const unchanged = submitted === JSON.stringify([...new FormData(form)]);
      feedback.dataset.state = ev.detail.successful ? (unchanged ? 'success' : 'draft') : 'error';
      feedback.textContent = ev.detail.successful
        ? (unchanged ? 'Received · verify live state' : 'Received · newer draft not sent')
        : (ev.detail.xhr?.status ? 'Not applied · HTTP ' + ev.detail.xhr.status + '. Check values and retry.' : 'Connection lost · outcome unknown. Check audit before retrying.');
      if (ev.detail.successful && unchanged) {
        form.dataset.dirty = 'false';
        button.textContent = label;
        button.title = 'Response received · check confirmed state above';
      }
    });
  });
})();
