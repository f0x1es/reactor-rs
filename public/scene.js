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
    sgDist: 1.65, pumpDist: 1.20,
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
    scene.add(vessel);

    // dome (top)
    const domeMat = new THREE.MeshStandardMaterial({ color: COLORS.dome, roughness: 0.25, metalness: 0.6, emissive: 0x080a0e });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(vesselR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.position.y = vesselH / 2;
    dome.castShadow = true;
    scene.add(dome);

    // bottom hemisphere
    const bot = new THREE.Mesh(
      new THREE.SphereGeometry(vesselR * 0.95, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      domeMat.clone(),
    );
    bot.position.y = -vesselH / 2;
    scene.add(bot);

    // flanges
    const flangeGeo = new THREE.TorusGeometry(vesselR + 0.04, 0.025, 12, 32);
    for (const fy of [vesselH / 2 - 0.02, 0.0, -vesselH / 2 + 0.02]) {
      const f = new THREE.Mesh(flangeGeo, flangeMat);
      f.position.y = fy;
      f.rotation.x = Math.PI / 2;
      scene.add(f);
    }

    // nozzle ring
    const nozRing = new THREE.Mesh(
      new THREE.TorusGeometry(vesselR + 0.02, 0.018, 10, 32),
      flangeMat,
    );
    nozRing.position.y = DIMS.nozzleH;
    nozRing.rotation.x = Math.PI / 2;
    scene.add(nozRing);

    // core glow
    coreGlow.position.set(0, 0, 0);
    scene.add(coreGlow);
    coreGlow2.position.set(0, -0.2, 0);
    scene.add(coreGlow2);

    // label
    label.position.set(0, vesselH / 2 + 0.85, 0);
    scene.add(label);
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
    scene.add(group);
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
    scene.add(cont);

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
    scene.add(ring);
  }

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
    const coldCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sgX - ca * 0.12, sgY - 0.12, sgZ - sa * 0.12),
      new THREE.Vector3(ca * 1.35, 0.0, sa * 1.35),
      new THREE.Vector3(ca * 1.25, pumpY + 0.12, sa * 1.25),
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

    scene.add(g);
    return { group: g, hotCurve, coldCurve, hotTube, coldTube, pump: pumpBody, sg: sgBody, steam, dots, sgMat, pMat };
  }

  // ── geometry: caravans ─────────────────────────────────────────

  const caravanMeshes = [];

  function buildCaravans() {
    const geo = new THREE.CapsuleGeometry(0.06, 0.14, 4, 8);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.caravan, roughness: 0.3, metalness: 0.3 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.z = Math.PI / 2;
      scene.add(mesh);
      caravanMeshes.push({ mesh, phase: (i / 10) * Math.PI * 2, spd: 1.0 });
    }
  }

  // ── build scene ────────────────────────────────────────────────

  buildPlatform();
  buildVessel();
  buildControlRods();
  buildContainment();
  for (let i = 0; i < 4; i++) loops.push(buildLoop(i));
  buildCaravans();

  // ── reactor state (updated by polling) ─────────────────────────

  const reactorState = {
    rodPct: 0,
    flow: 0,
    steamFlow: 0,
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
      reactorState.sn = [!!st.sn_a_on, !!st.sn_b_on, !!st.sn_c_on];

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
