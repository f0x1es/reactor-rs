(function () {
  if (!window.THREE) return;
  const host = document.getElementById('three');
  if (!host) return;

  // ── constants ──────────────────────────────────────────────────

  const COLORS = {
    vessel:       0xc8d4e0,
    dome:         0xd0dce8,
    flange:       0x8899aa,
    nozzle:       0x99aabb,
    platform:     0x1a1f28,
    grid:         0x252d3a,
    rod:          0x606870,
    rodHousing:   0x95a5b5,
    motor:        0x4a5a6a,
    support:      0x556677,
    sg:           0xc8b080,
    sgActive:     0xd4a853,
    sgOff:        0x3a3228,
    pump:         0x7a8a9c,
    pumpActive:   0x8899aa,
    pumpOff:      0x2a2d33,
    hotPipe:      0xd4836b,
    hotPipeActive:0xe8967a,
    hotPipeOff:   0x2a2025,
    coldPipe:     0x5a9ec7,
    coldPipeActive:0x6aaddb,
    coldPipeOff:  0x1a2530,
    dot:          0xeef4fa,
    dotOff:       0x333840,
    caravan:      0x60a5fa,
    containment:  0x4466aa,
    containmentHit: 0xaa4444,
    coreGlow:     0x2dd4bf,
    coreWarm:     0xff6644,
    steamPipe:    0x8899aa,
    fog:          0x080c12,
  };

  const DIMS = {
    vesselR: 0.32, vesselH: 1.6,
    pipeR: 0.038,
    sgR: 0.18, sgLen: 0.90,
    sgDist: 1.65, pumpDist: 2.15,
    nozzleH: 0.18,
    containmentR: 2.8,
    platformR: 3.5,
    // vver-ish: SGs are grouped in 2 pairs on opposite sides; within a pair ~30deg separation.
    loopAngles: [-(Math.PI / 12), (Math.PI / 12), Math.PI - (Math.PI / 12), Math.PI + (Math.PI / 12)],
  };

  const ORBIT = {
    minRadius: 2.2,
    maxRadius: 10.0,
    minPhi: 0.12,
    defaultRadius: 4.9,
    defaultTheta: Math.PI * 0.75,
    defaultPhi: Math.PI * 0.33,
    autoSpeed: 0.06,   // rad/s when not dragging
    dragSensitivity: 0.007,
    zoomSensitivity: 0.0012,
    idleDelay: 2000,   // ms after last drag before auto-orbit resumes
  };

  // ── helpers ────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function tempColor(tempC) {
    const t = clamp((tempC - 20) / 160, 0, 1);
    return new THREE.Color(
      lerp(0x2d, 0xfb, t) / 255,
      lerp(0xd4, 0x71, t) / 255,
      lerp(0xbf, 0x85, t) / 255,
    );
  }

  function makeLabel(text, fontSize) {
    const c = document.createElement('canvas');
    c.width = 768; c.height = 192;
    const ctx = c.getContext('2d');

    const fs = fontSize || 64;
    ctx.font = '800 ' + fs + 'px ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';

    // outline improves readability on bright backgrounds
    ctx.lineWidth = Math.max(6, Math.round(fs * 0.18));
    ctx.strokeStyle = 'rgba(4, 6, 10, 0.95)';

    ctx.fillStyle = '#e6edf3';
    ctx.shadowColor = 'rgba(96,165,250,.75)';
    ctx.shadowBlur = 22;

    const m = ctx.measureText(text);
    const x = Math.max(24, (c.width - m.width) / 2);
    const y = Math.round(c.height * 0.64);
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      // labels should remain readable even through transparent containment
      depthTest: false,
      depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.renderOrder = 10;
    spr.scale.set(2.4, 0.6, 1);
    return spr;
  }

  function makeBoard(text, fontSize) {
    const c = document.createElement('canvas');
    c.width = 768; c.height = 192;
    const ctx = c.getContext('2d');

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;

    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    const spr = new THREE.Sprite(mat);
    spr.renderOrder = 11;
    spr.scale.set(2.2, 0.55, 1);

    function draw(t) {
      const fs = fontSize || 56;
      ctx.clearRect(0, 0, c.width, c.height);

      // display background
      ctx.fillStyle = 'rgba(4, 6, 10, 0.72)';
      ctx.fillRect(18, 40, c.width - 36, c.height - 80);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 6;
      ctx.strokeRect(18, 40, c.width - 36, c.height - 80);

      ctx.font = '900 ' + fs + 'px ui-monospace, monospace';
      ctx.textBaseline = 'alphabetic';

      ctx.fillStyle = '#e6edf3';
      ctx.shadowColor = 'rgba(255, 230, 0, 0.55)';
      ctx.shadowBlur = 18;

      const m = ctx.measureText(t);
      const x = Math.max(36, (c.width - m.width) / 2);
      const y = Math.round(c.height * 0.64);
      ctx.fillText(t, x, y);

      tex.needsUpdate = true;
    }

    draw(text || 'p_el: 0 mw');

    return { spr, setText: draw };
  }

  // ── renderer ───────────────────────────────────────────────────

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
  } catch (e) {
    // webgl fallback
    const c = document.createElement('canvas');
    c.width = Math.max(1, host.clientWidth || 1);
    c.height = Math.max(1, host.clientHeight || 1);
    c.style.width = '100%'; c.style.height = '100%';
    host.appendChild(c);
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(6,10,14,.35)'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#9fb1c1'; ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('webgl off: 3d disabled', 14, 24);
    return;
  }

  // ── scene + camera ─────────────────────────────────────────────

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(COLORS.fog, 3, 18);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

  // ── orbit controller ──────────────────────────────────────────
  // manual drag to rotate, wheel to zoom, slow auto-orbit when idle.

  const orbit = {
    target: new THREE.Vector3(0, 0.2, 0),
    radius: ORBIT.defaultRadius,
    theta: ORBIT.defaultTheta,
    phi: ORBIT.defaultPhi,
    dragging: false,
    lastX: 0, lastY: 0,
    lastInteraction: 0,
  };

  function updateCamera() {
    const sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
    const st = Math.sin(orbit.theta), ct = Math.cos(orbit.theta);
    camera.position.set(
      orbit.target.x + orbit.radius * sp * ct,
      orbit.target.y + orbit.radius * cp,
      orbit.target.z + orbit.radius * sp * st,
    );
    camera.lookAt(orbit.target);
  }
  updateCamera();

  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (ev) => {
    orbit.dragging = true;
    orbit.lastX = ev.clientX;
    orbit.lastY = ev.clientY;
    orbit.lastInteraction = Date.now();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { }
  });
  canvas.addEventListener('pointerup', (ev) => {
    orbit.dragging = false;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { }
  });
  canvas.addEventListener('pointercancel', () => { orbit.dragging = false; });
  canvas.addEventListener('pointerleave', () => { orbit.dragging = false; });
  canvas.addEventListener('pointermove', (ev) => {
    if (!orbit.dragging) return;
    const dx = ev.clientX - orbit.lastX;
    const dy = ev.clientY - orbit.lastY;
    orbit.lastX = ev.clientX;
    orbit.lastY = ev.clientY;
    orbit.theta += dx * ORBIT.dragSensitivity;
    orbit.phi = clamp(orbit.phi - dy * ORBIT.dragSensitivity, ORBIT.minPhi, Math.PI - ORBIT.minPhi);
    orbit.lastInteraction = Date.now();
    updateCamera();
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    orbit.radius = clamp(orbit.radius * (1 + ev.deltaY * ORBIT.zoomSensitivity), ORBIT.minRadius, ORBIT.maxRadius);
    orbit.lastInteraction = Date.now();
    updateCamera();
  }, { passive: false });

  // ── lighting ───────────────────────────────────────────────────

  scene.add(new THREE.AmbientLight(0x8899bb, 0.50));

  const keyLight = new THREE.DirectionalLight(0xffeedd, 0.9);
  keyLight.position.set(4, 6, 3);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5; keyLight.shadow.camera.far = 20;
  keyLight.shadow.camera.left = -5; keyLight.shadow.camera.right = 5;
  keyLight.shadow.camera.top = 5; keyLight.shadow.camera.bottom = -5;
  scene.add(keyLight);

  const fill = new THREE.DirectionalLight(0x6688cc, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x88aaff, 0.25);
  rim.position.set(-1, 1, 4);
  scene.add(rim);

  // ── geometry: platform ─────────────────────────────────────────

  function buildPlatform() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(DIMS.platformR, DIMS.platformR, 0.06, 64),
      new THREE.MeshStandardMaterial({ color: COLORS.platform, roughness: 0.9, metalness: 0.1 }),
    );
    base.position.y = -0.83;
    base.receiveShadow = true;
    scene.add(base);

    const mat = new THREE.MeshStandardMaterial({ color: COLORS.grid, roughness: 0.95, metalness: 0 });
    for (let i = -6; i <= 6; i++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(7, 0.005, 0.008), mat);
      h.position.set(0, -0.795, i * 0.5);
      scene.add(h);
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.005, 7), mat);
      v.position.set(i * 0.5, -0.795, 0);
      scene.add(v);
    }
  }

  // ── geometry: reactor vessel ───────────────────────────────────

  const vesselMat = new THREE.MeshStandardMaterial({
    color: COLORS.vessel, roughness: 0.30, metalness: 0.55, emissive: 0x0a0c10,
  });
  const flangeMat = new THREE.MeshStandardMaterial({
    color: COLORS.flange, roughness: 0.4, metalness: 0.7,
  });
  const coreGlow = new THREE.PointLight(COLORS.coreGlow, 0, 2.5);
  const coreGlow2 = new THREE.PointLight(COLORS.coreWarm, 0, 1.8);
  const rods = [];
  const label = makeLabel('VVER-1000');

  function buildVessel() {
    const { vesselR, vesselH } = DIMS;

    // main body
    const vessel = new THREE.Mesh(new THREE.CylinderGeometry(vesselR, vesselR, vesselH, 32), vesselMat);
    vessel.castShadow = true;
    addPrimary(vessel);

    // dome (top)
    const domeMat = new THREE.MeshStandardMaterial({ color: COLORS.dome, roughness: 0.25, metalness: 0.6, emissive: 0x080a0e });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(vesselR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.position.y = vesselH / 2;
    dome.castShadow = true;
    addPrimary(dome);

    // bottom hemisphere
    const bot = new THREE.Mesh(
      new THREE.SphereGeometry(vesselR * 0.95, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      domeMat.clone(),
    );
    // keep the bottom cap above the platform plane to avoid poking through the floor.
    bot.position.y = -vesselH / 2 + 0.32;
    addPrimary(bot);

    // flanges
    const flangeGeo = new THREE.TorusGeometry(vesselR + 0.04, 0.025, 12, 32);
    for (const fy of [vesselH / 2 - 0.02, 0.0, -vesselH / 2 + 0.02]) {
      const f = new THREE.Mesh(flangeGeo, flangeMat);
      f.position.y = fy;
      f.rotation.x = Math.PI / 2;
      addPrimary(f);
    }

    // nozzle ring
    const nozRing = new THREE.Mesh(
      new THREE.TorusGeometry(vesselR + 0.02, 0.018, 10, 32),
      flangeMat,
    );
    nozRing.position.y = DIMS.nozzleH;
    nozRing.rotation.x = Math.PI / 2;
    addPrimary(nozRing);

    // core glow
    coreGlow.position.set(0, 0, 0);
    addPrimary(coreGlow);
    coreGlow2.position.set(0, -0.2, 0);
    addPrimary(coreGlow2);

    // label
    label.position.set(0, vesselH / 2 + 0.85, 0);
    addPrimary(label);
  }

  // ── geometry: control rods (CRDMs) ─────────────────────────────

  function buildControlRods() {
    const { vesselR, vesselH } = DIMS;
    const group = new THREE.Group();
    const housingGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.45, 10);
    const housingMat = new THREE.MeshStandardMaterial({ color: COLORS.rodHousing, roughness: 0.4, metalness: 0.5 });
    const rodGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.6, 8);
    const rodMat = new THREE.MeshStandardMaterial({ color: COLORS.rod, roughness: 0.5, metalness: 0.3 });

    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = (i % 2 === 0) ? 0.14 : 0.22;
      const hx = Math.cos(a) * rr, hz = Math.sin(a) * rr;

      const h = new THREE.Mesh(housingGeo, housingMat);
      h.position.set(hx, vesselH / 2 + 0.32 + 0.22, hz);
      h.castShadow = true;
      group.add(h);

      const rod = new THREE.Mesh(rodGeo, rodMat);
      rod.position.set(hx, vesselH / 2 + 0.1, hz);
      group.add(rod);
      rods.push({ mesh: rod, baseY: vesselH / 2 + 0.1 });
    }

    // top plate
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.30, 0.04, 32),
      flangeMat,
    );
    plate.position.y = vesselH / 2 + 0.10;
    group.add(plate);
    addPrimary(group);
  }

  // ── geometry: containment dome ─────────────────────────────────

  const contMat = new THREE.MeshStandardMaterial({
    color: COLORS.containment, roughness: 0.6, metalness: 0.1,
    transparent: true, opacity: 0.06, side: THREE.DoubleSide,
    // without this, the transparent dome still writes depth and hides labels when camera goes outside.
    depthWrite: false,
  });

  function buildContainment() {
    const cont = new THREE.Mesh(
      new THREE.SphereGeometry(DIMS.containmentR, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2),
      contMat,
    );
    cont.position.y = -0.8;
    addPrimary(cont);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(DIMS.containmentR, 0.02, 12, 64),
      new THREE.MeshStandardMaterial({
        color: 0x3355aa, roughness: 0.5, metalness: 0.3,
        transparent: true, opacity: 0.25,
        depthWrite: false,
      }),
    );
    ring.position.y = -0.8;
    ring.rotation.x = Math.PI / 2;
    addPrimary(ring);
  }

  const commonObjs = [];
  const primaryObjs = [];
  const secondaryObjs = [];

  function addCommon(obj) { scene.add(obj); commonObjs.push(obj); return obj; }
  function addPrimary(obj) { scene.add(obj); primaryObjs.push(obj); return obj; }
  function addSecondary(obj) { scene.add(obj); secondaryObjs.push(obj); return obj; }

  // ── geometry: primary loops (4x SG + MCP + piping) ─────────────

  const loops = [];

  function makeTube(curve, mat, radius) {
    const m = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 72, radius || DIMS.pipeR, 14, false),
      mat,
    );
    m.castShadow = true;
    return m;
  }

  function buildLoop(i) {
    const { vesselR, vesselH, sgDist, pumpDist, sgR, sgLen, nozzleH } = DIMS;
    const ang = DIMS.loopAngles[i];
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const pdx = -sa, pdz = ca;  // perpendicular direction
    const g = new THREE.Group();

    // ── SG (steam generator) ──
    const sgX = ca * sgDist, sgZ = sa * sgDist, sgY = 0.15;
    const sgMat = new THREE.MeshStandardMaterial({ color: COLORS.sg, roughness: 0.35, metalness: 0.50 });
    const sgBody = new THREE.Mesh(new THREE.CapsuleGeometry(sgR, sgLen, 16, 28), sgMat);
    sgBody.position.set(sgX, sgY, sgZ);
    sgBody.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
    sgBody.rotateZ(Math.PI / 2);
    sgBody.castShadow = true;
    g.add(sgBody);

    // SG nozzles
    const nozSgGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.12, 10);
    const nozSgMat = new THREE.MeshStandardMaterial({ color: COLORS.flange, roughness: 0.4, metalness: 0.5 });
    for (const dy of [0.06, -0.12]) {
      const noz = new THREE.Mesh(nozSgGeo, nozSgMat);
      noz.position.set(sgX - ca * 0.12, sgY + dy, sgZ - sa * 0.12);
      noz.rotation.z = Math.PI / 2;
      noz.rotation.y = -ang;
      g.add(noz);
    }

    // secondary steam pipe
    const steamPipeMat = new THREE.MeshStandardMaterial({ color: COLORS.steamPipe, roughness: 0.4, metalness: 0.5 });
    const steamPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 10), steamPipeMat);
    steamPipe.position.set(sgX, sgY + sgR + 0.25, sgZ);
    steamPipe.castShadow = true;
    g.add(steamPipe);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 10), steamPipeMat);
    elbow.position.set(sgX, sgY + sgR + 0.50, sgZ);
    g.add(elbow);

    // SG supports
    const legMat = new THREE.MeshStandardMaterial({ color: COLORS.support, roughness: 0.55, metalness: 0.45 });
    for (const off of [-sgLen * 0.28, sgLen * 0.28]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.022, sgY + 0.55, 8),
        legMat,
      );
      leg.position.set(sgX + pdx * off, sgY - (sgY + 0.55) / 2 - 0.08, sgZ + pdz * off);
      g.add(leg);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.015, 0.015), legMat);
      brace.position.set(sgX + pdx * off, -0.55, sgZ + pdz * off);
      brace.rotation.y = ang;
      g.add(brace);
    }

    // ── MCP (main coolant pump) ──
    const pumpX = ca * pumpDist, pumpZ = sa * pumpDist, pumpY = -0.38;
    const pMat = new THREE.MeshStandardMaterial({ color: COLORS.pump, roughness: 0.30, metalness: 0.60 });
    const pumpBody = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 24), pMat);
    pumpBody.position.set(pumpX, pumpY, pumpZ);
    pumpBody.castShadow = true;
    g.add(pumpBody);

    // pump flanges
    const pumpFlangeGeo = new THREE.TorusGeometry(0.13, 0.018, 10, 24);
    for (const fy of [-0.09, 0.09]) {
      const pf = new THREE.Mesh(pumpFlangeGeo, flangeMat.clone());
      pf.position.set(pumpX, pumpY + fy, pumpZ);
      pf.rotation.x = Math.PI / 2;
      g.add(pf);
    }

    // pump motor
    const motorMat = new THREE.MeshStandardMaterial({ color: COLORS.motor, roughness: 0.35, metalness: 0.55 });
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.30, 14), motorMat);
    motor.position.set(pumpX, pumpY + 0.26, pumpZ);
    motor.castShadow = true;
    g.add(motor);
    const motorCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      motorMat,
    );
    motorCap.position.set(pumpX, pumpY + 0.41, pumpZ);
    g.add(motorCap);

    // ── piping ──
    const hotMat = new THREE.MeshStandardMaterial({ color: COLORS.hotPipe, roughness: 0.38, metalness: 0.42 });
    const hotCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(ca * (vesselR + 0.05), nozzleH, sa * (vesselR + 0.05)),
      new THREE.Vector3(ca * 0.65, nozzleH + 0.06, sa * 0.65),
      new THREE.Vector3(ca * 1.05, sgY + 0.15, sa * 1.05),
      new THREE.Vector3(ca * 1.35, sgY + 0.10, sa * 1.35),
      new THREE.Vector3(sgX - ca * 0.12, sgY + 0.06, sgZ - sa * 0.12),
    ]);
    const hotTube = makeTube(hotCurve, hotMat);
    g.add(hotTube);

    const coldMat = new THREE.MeshStandardMaterial({ color: COLORS.coldPipe, roughness: 0.38, metalness: 0.42 });
    const midDist = (sgDist + pumpDist) * 0.50;
    const coldCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sgX - ca * 0.12, sgY - 0.12, sgZ - sa * 0.12),
      // pull the cold leg outward so the pump sits outside the SG (reference diagram)
      new THREE.Vector3(ca * midDist, -0.06, sa * midDist),
      new THREE.Vector3(ca * (pumpDist - 0.18), pumpY + 0.14, sa * (pumpDist - 0.18)),
      new THREE.Vector3(pumpX + ca * 0.02, pumpY + 0.05, pumpZ + sa * 0.02),
      new THREE.Vector3(pumpX - ca * 0.10, pumpY, pumpZ - sa * 0.10),
      new THREE.Vector3(ca * 0.75, -0.25, sa * 0.75),
      new THREE.Vector3(ca * (vesselR + 0.05), -0.18, sa * (vesselR + 0.05)),
    ]);
    const coldTube = makeTube(coldCurve, coldMat);
    g.add(coldTube);

    // vessel nozzle stubs
    const nozGeo = new THREE.CylinderGeometry(DIMS.pipeR + 0.01, DIMS.pipeR + 0.01, 0.08, 12);
    const nozMat = new THREE.MeshStandardMaterial({ color: COLORS.nozzle, roughness: 0.4, metalness: 0.5 });
    for (const [ny, label] of [[nozzleH, 'hot'], [-0.18, 'cold']]) {
      const n = new THREE.Mesh(nozGeo, nozMat);
      n.position.set(ca * (vesselR + 0.02), ny, sa * (vesselR + 0.02));
      n.rotation.z = Math.PI / 2;
      n.rotation.y = -ang;
      g.add(n);
    }

    // ── labels ──
    const sgLabel = makeLabel('SG-' + (i + 1), 44);
    sgLabel.scale.set(0.95, 0.24, 1);
    sgLabel.material.opacity = 0.85;
    sgLabel.position.set(sgX, sgY - sgR - 0.18, sgZ);
    g.add(sgLabel);

    const pumpLabel = makeLabel('MCP-' + (i + 1), 40);
    pumpLabel.scale.set(0.9, 0.22, 1);
    pumpLabel.material.opacity = 0.8;
    pumpLabel.position.set(pumpX, pumpY - 0.24, pumpZ);
    g.add(pumpLabel);

    const steam = makeLabel('steam', 46);
    steam.scale.set(1.2, 0.30, 1);
    steam.material.opacity = 0.0;
    steam.position.set(sgX, sgY + 0.58, sgZ);
    g.add(steam);

    // ── flow dots ──
    const dotGeo = new THREE.SphereGeometry(0.022, 8, 8);
    const dots = [];
    for (let k = 0; k < 14; k++) {
      const dm = new THREE.MeshStandardMaterial({ color: COLORS.dot, roughness: 0.3, metalness: 0.0 });
      const d = new THREE.Mesh(dotGeo, dm);
      g.add(d);
      dots.push({ mesh: d, t: k / 14 });
    }

    addPrimary(g);

    // anchor points for secondary loop (decorative)
    const steamOut = new THREE.Vector3(sgX, sgY + sgR + 0.50, sgZ);
    const feedIn = new THREE.Vector3(sgX - ca * 0.12, sgY - 0.12, sgZ - sa * 0.12);

    return { group: g, hotCurve, coldCurve, hotTube, coldTube, pump: pumpBody, sg: sgBody, steam, dots, sgMat, pMat, steamOut, feedIn, ang };
  }

  // ── geometry: secondary loop (decorative blocks only) ──────────

  const secondary = {
    curves: [],
    dots: [],
    turbine: null,
    ejectorJet: null,
    fwPumps: [],
    fwValves: [],
    sprayJets: [],
    pBoard: null,
  };

  function buildSecondary(loopObjs) {
    const headerR = 2.55;
    const headerY = 1.05;

    const steamMat = new THREE.MeshStandardMaterial({ color: 0xbcc6d3, roughness: 0.45, metalness: 0.35 });
    const feedMat = new THREE.MeshStandardMaterial({ color: 0x5aa0c9, roughness: 0.45, metalness: 0.35 });

    // steam header ring
    const header = new THREE.Mesh(
      new THREE.TorusGeometry(headerR, 0.018, 10, 72),
      steamMat,
    );
    header.position.y = headerY;
    header.rotation.x = Math.PI / 2;
    header.castShadow = true;
    // keep steam header visible in both views
    addCommon(header);

    // turbine block
    const turbMat = new THREE.MeshStandardMaterial({ color: 0x9aa7b6, roughness: 0.35, metalness: 0.55 });
    const turbine = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.95, 24), turbMat);
    turbine.position.set(3.55, 0.22, 0.0);
    turbine.rotation.z = Math.PI / 2;
    turbine.castShadow = true;
    addSecondary(turbine);
    secondary.turbine = turbine;

    const turbLabel = makeLabel('turbine', 44);
    turbLabel.scale.set(1.2, 0.30, 1);
    turbLabel.material.opacity = 0.85;
    turbLabel.position.set(3.55, 0.68, 0.0);
    addSecondary(turbLabel);

    // generator block (visual only)
    const genMat = new THREE.MeshStandardMaterial({ color: 0x93a3b5, roughness: 0.35, metalness: 0.55 });
    const generator = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.62, 24), genMat);
    generator.position.set(4.35, 0.22, 0.0);
    generator.rotation.z = Math.PI / 2;
    generator.castShadow = true;
    addSecondary(generator);

    const genLabel = makeLabel('gen', 44);
    genLabel.scale.set(0.9, 0.24, 1);
    genLabel.material.opacity = 0.75;
    genLabel.position.set(4.35, 0.62, 0.0);
    addSecondary(genLabel);

    const pBoard = makeBoard('p_el: 0 mw', 56);
    pBoard.spr.position.set(4.35, 0.92, 0.0);
    addSecondary(pBoard.spr);
    secondary.pBoard = pBoard;

    // condenser block
    const condMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.55, metalness: 0.25 });
    const condenser = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.42, 0.55), condMat);
    condenser.position.set(3.55, -0.55, 0.0);
    condenser.castShadow = true;
    addSecondary(condenser);

    const condLabel = makeLabel('cond', 44);
    condLabel.scale.set(1.0, 0.26, 1);
    condLabel.material.opacity = 0.75;
    condLabel.position.set(3.55, -0.08, 0.0);
    addSecondary(condLabel);

    // steam-jet ejector (always on; decorative)
    const ejX = 4.05;
    const ejY = -0.34;
    const ejZ = 0.42;

    const ejMat = new THREE.MeshStandardMaterial({ color: 0x9aa7b6, roughness: 0.35, metalness: 0.55 });
    const ejBody = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 16), ejMat);
    ejBody.position.set(ejX, ejY, ejZ);
    ejBody.rotation.z = Math.PI / 2;
    ejBody.castShadow = true;
    addSecondary(ejBody);

    const ejLabel = makeLabel('ej', 34);
    ejLabel.scale.set(0.55, 0.18, 1);
    ejLabel.material.opacity = 0.70;
    ejLabel.position.set(ejX, ejY + 0.20, ejZ);
    addSecondary(ejLabel);

    const ejPipe = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.12, -0.34, 0.05),
      new THREE.Vector3(4.18, -0.34, 0.28),
      new THREE.Vector3(ejX - 0.10, ejY, ejZ),
      new THREE.Vector3(ejX + 0.10, ejY, ejZ),
    ]);
    addSecondary(makeTube(ejPipe, steamMat, 0.010));

    const ejJetMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.10,
      metalness: 0.00,
      transparent: true,
      opacity: 0.0,
    });
    const ejJet = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.50, 14), ejJetMat);
    ejJet.position.set(ejX, ejY + 0.34, ejZ);
    ejJet.scale.y = 0.01;
    addSecondary(ejJet);
    secondary.ejectorJet = { mesh: ejJet, baseY: ejY + 0.34, phase: 1.7 };

    // spray ponds (closed cooling loop, visual only)
    const pondX = 5.35;
    const pondY = -1.10;
    const pondZ = 0.00;

    const pondMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.85, metalness: 0.05 });
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x0ea5e9,
      roughness: 0.25,
      metalness: 0.05,
      transparent: true,
      opacity: 0.35,
    });
    const cwMat = new THREE.MeshStandardMaterial({ color: 0x2dd4bf, roughness: 0.45, metalness: 0.20 });

    const pond = new THREE.Mesh(new THREE.BoxGeometry(1.90, 0.18, 1.10), pondMat);
    pond.position.set(pondX, pondY, pondZ);
    pond.castShadow = true;
    addSecondary(pond);

    const water = new THREE.Mesh(new THREE.PlaneGeometry(1.82, 1.02, 1, 1), waterMat);
    water.position.set(pondX, pondY + 0.10, pondZ);
    water.rotation.x = -Math.PI / 2;
    addSecondary(water);

    // cooling pipes: condenser <-> pond (closed loop)
    const toPond = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.10, -0.55, 0.18),
      new THREE.Vector3(4.55, -0.85, 0.40),
      new THREE.Vector3(pondX - 0.85, pondY - 0.05, 0.40),
      new THREE.Vector3(pondX - 0.78, pondY - 0.05, 0.20),
    ]);
    addSecondary(makeTube(toPond, cwMat, 0.014));

    const fromPond = new THREE.CatmullRomCurve3([
      new THREE.Vector3(pondX - 0.78, pondY - 0.05, -0.20),
      new THREE.Vector3(pondX - 0.85, pondY - 0.05, -0.40),
      new THREE.Vector3(4.55, -0.85, -0.40),
      new THREE.Vector3(4.10, -0.55, -0.18),
    ]);
    addSecondary(makeTube(fromPond, cwMat, 0.014));

    // a lot of fountain nozzles
    const nozMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.65, metalness: 0.15 });
    const nozGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10);

    const jetGeo = new THREE.CylinderGeometry(0.010, 0.006, 1.0, 10);
    const jetMat = new THREE.MeshStandardMaterial({
      color: 0x39d2ff,
      roughness: 0.10,
      metalness: 0.00,
      transparent: true,
      opacity: 0.50,
    });

    const nx = 8;
    const nz = 5;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const fx = (ix + 0.5) / nx;
        const fz = (iz + 0.5) / nz;
        const x = pondX + (fx - 0.5) * 1.60;
        const z = pondZ + (fz - 0.5) * 0.84;
        const y = pondY + 0.10;

        const n = new THREE.Mesh(nozGeo, nozMat);
        n.position.set(x, y - 0.02, z);
        n.castShadow = true;
        addSecondary(n);

        const j = new THREE.Mesh(jetGeo, jetMat);
        j.position.set(x, y + 0.05, z);
        j.scale.y = 0.08;
        addSecondary(j);

        secondary.sprayJets.push({ mesh: j, baseY: y + 0.05, phase: (ix * 17 + iz * 29) * 0.17 });
      }
    }

    // main steam line: header -> turbine
    const steamMainCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(headerR, headerY, 0.0),
      new THREE.Vector3(3.05, headerY, 0.0),
      new THREE.Vector3(3.25, 0.55, 0.0),
      new THREE.Vector3(3.10, 0.22, 0.0),
    ]);
    secondary.curves.push({ curve: steamMainCurve, kind: 'steam' });
    addSecondary(makeTube(steamMainCurve, steamMat, 0.020));

    // exhaust steam: turbine -> condenser
    const exhaustCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.02, 0.22, 0.0),
      new THREE.Vector3(4.15, -0.20, 0.0),
      new THREE.Vector3(3.95, -0.55, 0.0),
    ]);
    secondary.curves.push({ curve: exhaustCurve, kind: 'steam' });
    addSecondary(makeTube(exhaustCurve, steamMat, 0.018));

    // feedwater header (return) - low ring
    const feedHeaderR = 2.35;
    const feedHeaderY = -0.10;
    const feedHeader = new THREE.Mesh(
      new THREE.TorusGeometry(feedHeaderR, 0.016, 10, 72),
      feedMat,
    );
    feedHeader.position.y = feedHeaderY;
    feedHeader.rotation.x = Math.PI / 2;
    feedHeader.castShadow = true;
    addSecondary(feedHeader);

    // condenser -> deaerator -> feedwater pumps (x3) -> feed header
    const deaMat = new THREE.MeshStandardMaterial({ color: 0x7b8794, roughness: 0.45, metalness: 0.35 });

    const dea = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.78, 22), deaMat);
    dea.position.set(2.72, -0.55, 0.55);
    dea.rotation.z = Math.PI / 2;
    dea.castShadow = true;
    addSecondary(dea);

    const deaLabel = makeLabel('deaer', 40);
    deaLabel.scale.set(0.9, 0.24, 1);
    deaLabel.material.opacity = 0.75;
    deaLabel.position.set(2.72, -0.20, 0.55);
    addSecondary(deaLabel);

    const condOut = new THREE.Vector3(3.00, -0.55, 0.0);
    const deaIn = new THREE.Vector3(3.11, -0.55, 0.55);
    const deaOut = new THREE.Vector3(2.33, -0.55, 0.55);

    const condToDea = new THREE.CatmullRomCurve3([
      condOut,
      new THREE.Vector3(2.95, -0.55, 0.25),
      deaIn,
    ]);
    secondary.curves.push({ curve: condToDea, kind: 'feed' });
    addSecondary(makeTube(condToDea, feedMat, 0.016));

    const suction = new THREE.Vector3(2.20, -0.55, 0.0);
    const deaToSuction = new THREE.CatmullRomCurve3([
      deaOut,
      new THREE.Vector3(2.38, -0.55, 0.30),
      suction,
    ]);
    secondary.curves.push({ curve: deaToSuction, kind: 'feed' });
    addSecondary(makeTube(deaToSuction, feedMat, 0.014));

    const pumpMat = new THREE.MeshStandardMaterial({ color: 0x9aa7b6, roughness: 0.38, metalness: 0.55 });
    const impMat = new THREE.MeshStandardMaterial({ color: 0xffe600, roughness: 0.30, metalness: 0.10 });

    const isoValveBase = new THREE.MeshStandardMaterial({ color: 0xff2a2a, roughness: 0.35, metalness: 0.25 });
    const checkValveBase = new THREE.MeshStandardMaterial({ color: 0xffe600, roughness: 0.35, metalness: 0.10 });
    const valveGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.06, 12);
    const valveHandleGeo = new THREE.BoxGeometry(0.07, 0.02, 0.02);

    const gaugeBodyMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.35, metalness: 0.55 });
    const gaugeDialMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.75, metalness: 0.05 });
    const tcMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.45 });

    function addIsoValve(x, y, z) {
      const mat = isoValveBase.clone();
      mat.emissive = new THREE.Color(0x000000);

      const v = new THREE.Mesh(valveGeo, mat);
      v.position.set(x, y, z);
      v.rotation.z = Math.PI / 2;
      v.castShadow = true;
      addSecondary(v);

      const h = new THREE.Mesh(valveHandleGeo, mat);
      h.position.set(x, y + 0.06, z);
      h.castShadow = true;
      addSecondary(h);

      return { body: v, handle: h, mat };
    }

    function addCheckValve(x, y, z) {
      const mat = checkValveBase.clone();
      mat.emissive = new THREE.Color(0x000000);

      const v = new THREE.Mesh(valveGeo, mat);
      v.position.set(x, y, z);
      v.rotation.z = Math.PI / 2;
      v.castShadow = true;
      addSecondary(v);

      return { body: v, mat };
    }

    function addGauge(x, y, z) {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.018, 16), gaugeBodyMat);
      body.position.set(x, y + 0.10, z);
      body.rotation.x = Math.PI / 2;
      body.castShadow = true;
      addSecondary(body);

      const dial = new THREE.Mesh(new THREE.CircleGeometry(0.042, 16), gaugeDialMat);
      dial.position.set(x, y + 0.10, z + 0.012);
      dial.castShadow = false;
      addSecondary(dial);

      const needle = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.003, 0.002), checkValveBase);
      needle.position.set(x, y + 0.10, z + 0.014);
      needle.rotation.z = -0.9;
      addSecondary(needle);

      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 12), gaugeBodyMat);
      stem.position.set(x, y + 0.06, z);
      stem.rotation.z = Math.PI / 2;
      addSecondary(stem);
    }

    function addThermocouple(x, y, z) {
      const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 12), tcMat);
      probe.position.set(x, y + 0.02, z);
      probe.rotation.z = Math.PI / 2;
      probe.castShadow = true;
      addSecondary(probe);

      const head = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.018, 0.018), tcMat);
      head.position.set(x, y + 0.045, z);
      head.castShadow = true;
      addSecondary(head);
    }

    const pumpXs = 2.05;
    const pumpY = -0.58;
    const pumpZs = [-0.55, 0.0, 0.55];

    const discharge = new THREE.Vector3(2.55, -0.28, 0.0);

    for (let pi = 0; pi < 3; pi++) {
      const z = pumpZs[pi];

      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.30, 18), pumpMat);
      body.position.set(pumpXs, pumpY, z);
      body.rotation.z = Math.PI / 2;
      body.castShadow = true;
      addSecondary(body);

      const imp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12), impMat);
      imp.position.set(pumpXs - 0.10, pumpY, z);
      imp.rotation.z = Math.PI / 2;
      imp.castShadow = true;
      addSecondary(imp);
      secondary.fwPumps.push(imp);

      const sIn = new THREE.Vector3(pumpXs + 0.18, pumpY, z);
      const sCurve = new THREE.CatmullRomCurve3([
        suction,
        new THREE.Vector3(2.16, pumpY, z),
        sIn,
      ]);
      secondary.curves.push({ curve: sCurve, kind: 'feed' });
      addSecondary(makeTube(sCurve, feedMat, 0.010));

      // suction isolation valve
      const vS = addIsoValve(pumpXs + 0.10, pumpY, z);

      const sOut = new THREE.Vector3(pumpXs - 0.22, pumpY, z);
      const dCurve = new THREE.CatmullRomCurve3([
        sOut,
        new THREE.Vector3(2.00, -0.34, z),
        discharge,
      ]);
      secondary.curves.push({ curve: dCurve, kind: 'feed' });
      addSecondary(makeTube(dCurve, feedMat, 0.010));

      // discharge isolation + check valve
      const vD = addIsoValve(pumpXs - 0.30, pumpY, z);
      const vCk = addCheckValve(pumpXs - 0.38, pumpY, z);

      secondary.fwValves.push({ suction: vS, discharge: vD, check: vCk });

      // discharge instruments: pressure gauge + thermocouple
      addGauge(pumpXs - 0.50, pumpY, z);
      addThermocouple(pumpXs - 0.56, pumpY, z);
    }

    const toHeader = new THREE.CatmullRomCurve3([
      discharge,
      new THREE.Vector3(2.45, -0.18, 0.0),
      new THREE.Vector3(feedHeaderR, feedHeaderY, 0.0),
    ]);
    secondary.curves.push({ curve: toHeader, kind: 'feed' });
    addSecondary(makeTube(toHeader, feedMat, 0.016));

    // connect each SG to steam header + feed header
    for (const L of loopObjs) {
      const a = Math.atan2(L.steamOut.z, L.steamOut.x);
      const hx = Math.cos(a) * headerR;
      const hz = Math.sin(a) * headerR;
      const headerPoint = new THREE.Vector3(hx, headerY, hz);

      const steamCurve = new THREE.CatmullRomCurve3([
        L.steamOut.clone(),
        new THREE.Vector3(L.steamOut.x * 0.85, headerY - 0.08, L.steamOut.z * 0.85),
        headerPoint,
      ]);
      secondary.curves.push({ curve: steamCurve, kind: 'steam' });
      // keep SG steam lead-in to header visible in both views
      addCommon(makeTube(steamCurve, steamMat, 0.014));

      const fx = Math.cos(a) * feedHeaderR;
      const fz = Math.sin(a) * feedHeaderR;
      const feedPoint = new THREE.Vector3(fx, feedHeaderY, fz);

      const feedCurve = new THREE.CatmullRomCurve3([
        feedPoint,
        new THREE.Vector3(L.feedIn.x * 0.85, feedHeaderY + 0.06, L.feedIn.z * 0.85),
        L.feedIn.clone(),
      ]);
      secondary.curves.push({ curve: feedCurve, kind: 'feed' });
      addSecondary(makeTube(feedCurve, feedMat, 0.012));
    }

    // flow dots for secondary
    const dotGeo2 = new THREE.SphereGeometry(0.016, 8, 8);
    for (let i = 0; i < secondary.curves.length; i++) {
      const { kind } = secondary.curves[i];
      for (let k = 0; k < 6; k++) {
        const dm = new THREE.MeshStandardMaterial({
          color: kind === 'steam' ? 0xeef4fa : 0xa7d5f2,
          roughness: 0.25,
          metalness: 0.0,
        });
        const d = new THREE.Mesh(dotGeo2, dm);
        addSecondary(d);
        secondary.dots.push({ mesh: d, curveIndex: i, t: (k / 6) });
      }
    }
  }

  // ── geometry: caravans ─────────────────────────────────────────

  const caravanMeshes = [];

  function buildCaravans() {
    const geo = new THREE.CapsuleGeometry(0.06, 0.14, 4, 8);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.caravan, roughness: 0.3, metalness: 0.3 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.z = Math.PI / 2;
      addPrimary(mesh);
      caravanMeshes.push({ mesh, phase: (i / 10) * Math.PI * 2, spd: 1.0 });
    }
  }

  // ── build scene ────────────────────────────────────────────────

  buildPlatform();
  buildVessel();
  buildControlRods();
  buildContainment();
  for (let i = 0; i < 4; i++) loops.push(buildLoop(i));
  buildSecondary(loops);
  buildCaravans();

  // ── view switching (primary vs secondary) ─────────────────────

  let viewMode = (localStorage.getItem('reactor_3d_view') || 'primary');

  function setBtnActive(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-active', !!on);
  }

  function applyView(mode) {
    viewMode = (mode === 'secondary') ? 'secondary' : 'primary';
    localStorage.setItem('reactor_3d_view', viewMode);

    for (const o of commonObjs) o.visible = true;
    for (const o of primaryObjs) o.visible = (viewMode === 'primary');
    for (const o of secondaryObjs) o.visible = (viewMode === 'secondary');

    setBtnActive('view-primary', viewMode === 'primary');
    setBtnActive('view-secondary', viewMode === 'secondary');

    if (viewMode === 'secondary') {
      orbit.target.set(3.4, -0.1, 0.0);
      orbit.radius = 5.8;
      orbit.theta = Math.PI;
      orbit.phi = Math.PI * 0.38;
    } else {
      orbit.target.set(0.0, 0.2, 0.0);
      orbit.radius = ORBIT.defaultRadius;
      orbit.theta = ORBIT.defaultTheta;
      orbit.phi = ORBIT.defaultPhi;
    }
    orbit.lastInteraction = Date.now();
    updateCamera();
  }

  const btnP = document.getElementById('view-primary');
  const btnS = document.getElementById('view-secondary');
  if (btnP) btnP.addEventListener('click', () => applyView('primary'));
  if (btnS) btnS.addEventListener('click', () => applyView('secondary'));

  applyView(viewMode);

  // ── reactor state (updated by polling) ─────────────────────────

  const reactorState = {
    rodPct: 0,
    flow: 0,
    steamFlow: 0,
    pElMw: 0,
    fwActive: 'a',
    sn: [true, true, true],
    alarms: '',
    impactShakeUntil: 0,
  };

  async function pollStatus() {
    try {
      const r = await fetch('/status');
      if (!r.ok) return;
      const st = await r.json();
      const avgP = st.zones.reduce((s, z) => s + z.power_pct, 0) / Math.max(1, st.zones.length);
      const z0 = st.zones && st.zones[0];
      const tempC = z0 ? z0.temp_c : 20;

      reactorState.rodPct = st.control_rod_pct || 0;
      reactorState.flow = st.primary_flow_kg_s || 0;
      reactorState.steamFlow = st.steam_flow_kg_s || 0;
      reactorState.pElMw = (typeof st.power_el_mw === 'number') ? st.power_el_mw : 0;
      reactorState.fwActive = st.fw_active || 'a';
      reactorState.sn = [!!st.sn_a_on, !!st.sn_b_on, !!st.sn_c_on];

      if (secondary.pBoard) {
        secondary.pBoard.setText('p_el: ' + Math.round(reactorState.pElMw) + ' mw');
      }

      // vessel emissive from temperature
      const c = tempColor(tempC);
      vesselMat.emissive.copy(c).multiplyScalar(0.08);

      // core glow
      const pn = clamp(avgP / 100, 0, 1);
      coreGlow.intensity = pn * 2.5;
      coreGlow.color.copy(c);
      coreGlow2.intensity = pn * 1.2;

      // alarms
      const alarmStr = (st.alarms || []).join(' ');
      reactorState.alarms = alarmStr;

      // share latest status with other ui modules without extra polling
      try {
        window.__reactorStatus = st;
        window.dispatchEvent(new CustomEvent('reactor:status', { detail: st }));
      } catch (e) { }

      if (alarmStr.includes('containment_hit')) {
        reactorState.impactShakeUntil = Date.now() + 2000;
        contMat.opacity = 0.15;
        contMat.color.setHex(COLORS.containmentHit);
      } else {
        contMat.opacity = 0.06;
        contMat.color.setHex(COLORS.containment);
      }

      // caravan speed scales with power
      const spd = 0.5 + (avgP / 100) * 2.5;
      for (const cv of caravanMeshes) cv.spd = spd;
    } catch (e) { }
  }
  pollStatus();
  setInterval(pollStatus, 1000);

  // ── resize ─────────────────────────────────────────────────────

  function resize() {
    const w = Math.max(1, host.clientWidth || 1);
    const h = Math.max(1, host.clientHeight || 1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── animate ────────────────────────────────────────────────────

  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    const now = Date.now();
    const st = reactorState;

    // orbit: auto-rotate when idle, manual when dragging
    if (!orbit.dragging && (now - orbit.lastInteraction) > ORBIT.idleDelay) {
      orbit.theta += dt * ORBIT.autoSpeed;
      updateCamera();
    }

    // shake on containment hit
    if (now < st.impactShakeUntil) {
      const sx = (Math.random() - 0.5) * 0.12;
      const sy = (Math.random() - 0.5) * 0.12;
      camera.position.x += sx;
      camera.position.y += sy;
    }

    // label blink on voronezh_moment
    if (st.alarms.includes('voronezh_moment')) {
      label.material.opacity = (now % 400) < 200 ? 1 : 0.2;
    } else {
      label.material.opacity = 0.9;
    }

    // control rods
    const ins = clamp(st.rodPct / 100, 0, 1);
    for (const rod of rods) {
      rod.mesh.position.y = rod.baseY - ins * 0.5;
    }

    // loop visuals
    const loopOn = [st.sn[0], st.sn[0], st.sn[1], st.sn[2]];
    const flowN = clamp(st.flow / 15000, 0, 1);
    const steamN = clamp(st.steamFlow / 2000, 0, 1);
    const hot = st.alarms.includes('temp_high');

    for (let i = 0; i < loops.length; i++) {
      const on = loopOn[i];
      const L = loops[i];

      L.hotTube.material.color.setHex(on ? COLORS.hotPipeActive : COLORS.hotPipeOff);
      L.hotTube.material.emissive.setHex(hot ? 0x3b0b0b : 0x000000);
      L.coldTube.material.color.setHex(on ? COLORS.coldPipeActive : COLORS.coldPipeOff);
      L.coldTube.material.emissive.setHex(hot ? 0x150808 : 0x000000);

      L.sg.material.color.setHex(on ? COLORS.sgActive : COLORS.sgOff);
      L.sg.material.emissive.setHex(on ? 0x1a1200 : 0x000000);

      L.pump.material.color.setHex(on ? COLORS.pumpActive : COLORS.pumpOff);
      L.pump.material.emissive.setHex(on ? 0x000000 : 0x110000);
      L.pump.rotation.y += dt * (on ? (0.8 + flowN * 6.0) : 0.1);

      L.steam.material.opacity = on ? (0.05 + steamN * 0.6) : 0.0;

      // flow dots
      for (const d of L.dots) {
        d.t = (d.t + dt * (on ? (0.12 + flowN * 0.85) : 0.02)) % 1.0;
        const p = d.t < 0.5
          ? L.hotCurve.getPointAt(d.t * 2)
          : L.coldCurve.getPointAt((d.t - 0.5) * 2);
        d.mesh.position.copy(p);
        d.mesh.material.color.setHex(on ? COLORS.dot : COLORS.dotOff);
        d.mesh.material.emissive.setHex(on ? (d.t < 0.5 ? 0x331108 : 0x081833) : 0x000000);
      }
    }

    // secondary flow dots (decorative)
    for (const d of secondary.dots) {
      const C = secondary.curves[d.curveIndex];
      const spd = (C && C.kind === 'steam') ? (0.10 + steamN * 0.90) : (0.05 + flowN * 0.60);
      d.t = (d.t + dt * spd) % 1.0;
      const p = C.curve.getPointAt(d.t);
      d.mesh.position.copy(p);
      d.mesh.material.opacity = 1.0;
      d.mesh.material.transparent = false;
    }

    // turbine spin hint (decorative)
    if (secondary.turbine) secondary.turbine.rotation.x += dt * (0.4 + steamN * 5.0);

    // spray ponds fountains (decorative)
    for (const j of secondary.sprayJets) {
      const amp = 0.08 + steamN * 0.65;
      const wobble = 0.85 + 0.15 * Math.sin(t * 2.2 + j.phase);
      const h = amp * wobble;
      j.mesh.scale.y = h;
      j.mesh.position.y = j.baseY + (h * 0.50);
      j.mesh.material.opacity = 0.18 + steamN * 0.55;
    }

    // condenser ejector jet (decorative)
    if (secondary.ejectorJet) {
      const j = secondary.ejectorJet;
      const on = steamN > 0.02;
      const amp = 0.02 + steamN * 0.65;
      const wobble = 0.90 + 0.10 * Math.sin(t * 3.5 + j.phase);
      const h = amp * wobble;
      j.mesh.scale.y = on ? h : 0.01;
      j.mesh.position.y = j.baseY + (h * 0.25);
      j.mesh.material.opacity = on ? (0.08 + steamN * 0.50) : 0.0;
    }

    function fwIdx(id) {
      return (id === 'b') ? 1 : (id === 'c') ? 2 : 0;
    }

    function setValveOpen(v, open) {
      if (!v || !v.mat) return;
      const on = !!open;
      v.mat.emissive.setHex(on ? 0x0a3a16 : 0x2a0000);
      if (v.handle) v.handle.rotation.z = on ? 0.0 : (Math.PI / 2);
    }

    // feedwater pumps + valves
    const active = fwIdx(st.fwActive);
    for (let i = 0; i < secondary.fwPumps.length; i++) {
      const imp = secondary.fwPumps[i];
      const on = (i === active);
      imp.rotation.x += dt * (on ? (0.6 + steamN * 6.0) : 0.02);

      const vs = secondary.fwValves[i];
      if (vs) {
        setValveOpen(vs.suction, on);
        setValveOpen(vs.discharge, on);
        // check valve opens only in flow direction.
        setValveOpen(vs.check, on);
      }
    }

    // caravans orbit
    for (const cv of caravanMeshes) {
      const a = cv.phase + t * (cv.spd || 1);
      const r = 2.4 + 0.15 * Math.sin(a * 2);
      cv.mesh.position.set(Math.cos(a) * r, -0.65 + 0.05 * Math.sin(a * 3), Math.sin(a) * r);
      cv.mesh.lookAt(0, -0.5, 0);
    }

    renderer.render(scene, camera);
  }
  animate();
})();
