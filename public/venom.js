(function(){
  const vp = document.getElementById('vp');
  const toast = document.getElementById('toast');

  const menuBtn = document.getElementById('menuBtn');
  const settings = document.getElementById('settings');

  const trojanBtn = document.getElementById('trojanBtn');
  const trojanState = document.getElementById('trojanState');

  const serverBtn = document.getElementById('serverBtn');
  const serverState = document.getElementById('serverState');

  const topupBtn = document.getElementById('topupBtn');
  const balEl = document.getElementById('bal');

  let trojanOn = false;
  const serverModes = ['выкл', 'bluetooth', 'udp', 'magadan'];
  let serverIdx = 0;

  function showToast(msg){
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{ toast.hidden = true; }, 1400);
  }

  function setTrojan(on){
    trojanOn = !!on;
    if (vp) vp.classList.toggle('vp--trojan', trojanOn);
    if (trojanState) trojanState.textContent = trojanOn ? 'on (муляж)' : 'off (муляж)';
    showToast(trojanOn ? 'троян: on (мем, не настоящий)' : 'троян: off');
  }

  function nextServer(){
    serverIdx = (serverIdx + 1) % serverModes.length;
    const v = serverModes[serverIdx];
    if (serverState) serverState.textContent = v;
    showToast('сервер: ' + v);
  }

  function parseBal(){
    const v = parseFloat((balEl && balEl.textContent || '0').replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  }

  function setBal(v){
    if (!balEl) return;
    const x = Math.max(0, Math.round(v * 100) / 100);
    balEl.textContent = x.toFixed(2);
  }

  function topUp(){
    const b = parseBal();
    const add = 3.14 + (Math.random() * 2.72);
    setBal(b + add);
    showToast('пополнение: +' + add.toFixed(2) + ' rub (шутка)');
  }

  if (menuBtn && settings) {
    menuBtn.addEventListener('click', ()=>{
      const hidden = settings.hasAttribute('hidden');
      settings.toggleAttribute('hidden', !hidden);
      showToast(hidden ? 'меню: open' : 'меню: close');
    });
  }

  if (trojanBtn) trojanBtn.addEventListener('click', ()=> setTrojan(!trojanOn));
  if (serverBtn) serverBtn.addEventListener('click', nextServer);
  if (topupBtn) topupBtn.addEventListener('click', topUp);

  // init
  setTrojan(false);
  nextServer();
})();
