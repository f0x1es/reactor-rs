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
})();