(function(){
  // audio: starts on first user gesture; toggle via topbar button.
  let audio = null;
  let audioOn = false;
  const stateEl = document.getElementById('musicState');
  
  function setAudioState(on){
    audioOn = on;
    if (stateEl) stateEl.textContent = on ? 'on' : 'off';
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
      // autoplay restrictions; ignore.
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
    btn.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') toggleAudio(); });
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
          { label: 'max temp c', data: [], borderColor: '#fb7185', tension: 0.25, pointRadius: 0, yAxisID: 'y1' },
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
    try {
      const r = await fetch('/history');
      if (!r.ok) return;
      const hist = await r.json();
      const c = ensureChart();
      if (!c) return;
      c.data.labels = hist.map(p => p.t_s);
      c.data.datasets[0].data = hist.map(p => p.avg_power_pct);
      c.data.datasets[1].data = hist.map(p => p.max_temp_c);
      c.update();
    } catch (e) {}
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

  // audit: render unix seconds to local hh:mm:ss in the ui.
  function pad2(n){
    return (n < 10 ? '0' : '') + n;
  }

  function formatAuditTs(root){
    const scope = root || document;
    if (!scope.querySelectorAll) return;
    const els = scope.querySelectorAll('.audit-log__ts[data-ts]');
    for (const el of els) {
      const ts = parseInt(el.getAttribute('data-ts') || '', 10);
      if (!Number.isFinite(ts)) continue;
      const d = new Date(ts * 1000);
      const s = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      if (el.textContent !== s) el.textContent = s;
      el.title = d.toLocaleString();
    }
  }

  formatAuditTs(document);
  document.body.addEventListener('htmx:afterSwap', (ev) => {
    const t = ev && ev.detail && ev.detail.target;
    if (t && t.id === 'audit') formatAuditTs(t);
  });
})();
