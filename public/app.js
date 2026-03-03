(function(){
  // audio: starts on first user gesture; toggle via topbar button.
  let audio = null;
  let audioOn = false;
  const stateEl = document.getElementById('musicState');

  // bipki: procedural beeps on critical alarms (opt-in).
  let bipkiOn = (localStorage.getItem('reactor_bipki') || 'off') === 'on';
  let beepCtx = null;
  let lastCritical = new Set();
  const bipkiStateEl = document.getElementById('bipkiState');

  function setBipkiState(on){
    bipkiOn = !!on;
    localStorage.setItem('reactor_bipki', bipkiOn ? 'on' : 'off');
    if (bipkiStateEl) bipkiStateEl.textContent = bipkiOn ? 'on' : 'off';
  }

  function ensureBeepCtx(){
    if (beepCtx) return beepCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    beepCtx = new AC();
    return beepCtx;
  }

  function beep(freq, ms){
    const ctx = ensureBeepCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq || 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ms||90)/1000.0);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + (ms||90)/1000.0 + 0.02);
  }

  const bipkiBtn = document.getElementById('bipkiBtn');
  if (bipkiBtn) {
    // init from storage
    setBipkiState(bipkiOn);
    bipkiBtn.addEventListener('click', ()=>{
      setBipkiState(!bipkiOn);
      if (bipkiOn) ensureBeepCtx();
    });
    bipkiBtn.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') { setBipkiState(!bipkiOn); if (bipkiOn) ensureBeepCtx(); } });
  }
  
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

  const pizdecEl = document.getElementById('pizdecBanner');

  // fire theme + unsafe overlays: prefer scene.js status events; fallback to polling only when scene isn't active (e.g. webgl off).
  function applyStatus(st){
    const alarms = (st && Array.isArray(st.alarms)) ? st.alarms : [];

    // theme: unsafe -> always fire; normal -> normal (no fire)
    const fire = !!(st && st.unsafe_mode);
    document.body.classList.toggle('temp-high', fire);

    // pizdec banner: unsafe + >=95% target on any zone
    let pizdec = false;
    if (st && st.unsafe_mode && Array.isArray(st.zones)) {
      let mx = 0;
      for (const z of st.zones) mx = Math.max(mx, (z && z.target_power_pct) ? z.target_power_pct : 0);
      pizdec = mx >= 95 || alarms.includes('pizdec') || alarms.includes('meltdown');
    }
    if (pizdecEl) pizdecEl.hidden = !pizdec;

    // bipki: in pizdec, force-on regardless of saved toggle
    const effectiveBipki = bipkiOn || pizdec;
    if (bipkiStateEl) bipkiStateEl.textContent = effectiveBipki ? 'on' : 'off';
    if (effectiveBipki) ensureBeepCtx();

    // beep when a new critical alarm appears
    const criticalList = ['pipe_rupture','containment_hit','power_lost','temp_high','scram_active','meltdown'];
    const cur = new Set();
    for (const a of alarms) if (criticalList.includes(a)) cur.add(a);

    if (effectiveBipki) {
      for (const a of cur) {
        if (!lastCritical.has(a)) {
          // quick double-beep
          beep(880, 75);
          setTimeout(()=>beep(660, 85), 110);
          break;
        }
      }
    }
    lastCritical = cur;
  }

  let lastStatusEventAt = 0;
  let fallbackTimer = null;

  async function fallbackPollOnce() {
    try {
      const r = await fetch('/status');
      if (!r.ok) return;
      const st = await r.json();
      applyStatus(st);
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
    applyStatus(window.__reactorStatus);
  }

  // if no scene status events arrived quickly, enable fallback polling.
  setTimeout(() => {
    if (Date.now() - lastStatusEventAt > 1500) startFallbackPoll();
  }, 1700);
})();