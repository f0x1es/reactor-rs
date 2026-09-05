(function () {
  if (!window.THREE) return;
  const host = document.getElementById('three');
  if (!host) return;

  // Three r150 defaults to legacy color management; use a linear lighting
  // workflow so painted metal and concrete are not washed out by sRGB output.
  THREE.ColorManagement.legacyMode = false;

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
    sg:           0x9facad,
    sgActive:     0xa7b4b6,
    sgOff:        0x526069,
    pump:         0x7a8a9c,
    pumpActive:   0x8899aa,
    pumpOff:      0x2a2d33,
    hotPipe:      0xb76c44,
    hotPipeActive:0xc38458,
    hotPipeOff:   0x694d3e,
    coldPipe:     0x437e8d,
    coldPipeActive:0x568f9e,
    coldPipeOff:  0x38525e,
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
    pipeR: 0.052,
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
    defaultRadius: 10.0,
    defaultTheta: Math.PI * 0.40,
    defaultPhi: Math.PI * 0.30,
    autoSpeed: 0.018,   // rad/s when not dragging
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
    ctx.font = '500 ' + fs + 'px ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';

    // outline improves readability on bright backgrounds
    ctx.lineWidth = Math.max(6, Math.round(fs * 0.18));
    ctx.strokeStyle = 'rgba(4, 6, 10, 0.95)';

    ctx.fillStyle = '#e6edf3';
    ctx.shadowColor = 'rgba(96,165,250,.75)';
    ctx.shadowBlur = 0;

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
    spr.scale.set(1.5, 0.375, 1);
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
      ctx.shadowBlur = 0;
      ctx.clearRect(0, 0, c.width, c.height);

      // display background
      ctx.fillStyle = 'rgba(4, 6, 10, 0.72)';
      ctx.fillRect(18, 40, c.width - 36, c.height - 80);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 6;
      ctx.strokeRect(18, 40, c.width - 36, c.height - 80);

      ctx.font = '500 ' + fs + 'px ui-monospace, monospace';
      ctx.textBaseline = 'alphabetic';

      ctx.fillStyle = '#e6edf3';
      ctx.shadowColor = 'rgba(255, 230, 0, 0.55)';
      ctx.shadowBlur = 0;

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
    renderer.toneMappingExposure = 0.95;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Static industrial structures do not need a fresh shadow pass every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
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
  scene.background = new THREE.Color(0x101b25);
  scene.fog = new THREE.Fog(0x101b25, 12, 28);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 60);

  // ── orbit controller ──────────────────────────────────────────
  // manual drag to rotate, wheel to zoom, slow auto-orbit when idle.

  const orbit = {
    target: new THREE.Vector3(0, 0.0, 0),
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
    orbit.phi = clamp(orbit.phi - dy * ORBIT.dragSensitivity, ORBIT.minPhi, Math.PI * 0.48);
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

  scene.add(new THREE.HemisphereLight(0xdcecff, 0x3b4145, 0.6));

  const keyLight = new THREE.DirectionalLight(0xffe8cb, 1.4);
  keyLight.position.set(4, 6, 3);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.018;
  keyLight.shadow.camera.near = 0.5; keyLight.shadow.camera.far = 20;
  keyLight.shadow.camera.left = -5; keyLight.shadow.camera.right = 5;
  keyLight.shadow.camera.top = 5; keyLight.shadow.camera.bottom = -5;
  scene.add(keyLight);

  const fill = new THREE.DirectionalLight(0x95bada, 0.4);
  fill.position.set(-3, 2, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xc8e9ed, 0.9);
  rim.position.set(-4, 4, -5);
  scene.add(rim);

  // ── geometry: platform ─────────────────────────────────────────

  // All detailing is procedural: no model downloads, new dependencies or API changes.
  // Repeated fasteners, fins and grating are instanced, not individual draw calls.
  const detailMaterials = {
    steel: new THREE.MeshStandardMaterial({ color: 0x8b9b9e, metalness: 0.78, roughness: 0.32 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x263c48, metalness: 0.65, roughness: 0.46 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0x56616a, metalness: 0.02, roughness: 0.94 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xd0a445, metalness: 0.25, roughness: 0.48 }),
    seam: new THREE.MeshStandardMaterial({ color: 0x47585e, metalness: 0.8, roughness: 0.46 }),
    white: new THREE.MeshStandardMaterial({ color: 0xd9dedb, metalness: 0.08, roughness: 0.65 }),
  };
  const detailGeometry = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 24),
    bolt: new THREE.CylinderGeometry(1, 1, 1, 6),
  };

  function detailBatch(parent) {
    const batches = new Map();
    const transform = new THREE.Object3D();
    return {
      part(kind, material, position, scale, rotation) {
        const key = kind + ':' + material;
        if (!batches.has(key)) batches.set(key, []);
        transform.position.set(...position);
        transform.scale.set(...scale);
        transform.rotation.set(...(rotation || [0, 0, 0]));
        transform.updateMatrix();
        batches.get(key).push(transform.matrix.clone());
      },
      finish() {
        for (const [key, matrices] of batches) {
          const [kind, material] = key.split(':');
          const mesh = new THREE.InstancedMesh(detailGeometry[kind], detailMaterials[material], matrices.length);
          matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
          mesh.name = kind + '-' + material;
          mesh.castShadow = mesh.receiveShadow = true;
          parent.add(mesh);
        }
      },
    };
  }

  function ring(parent, radius, tube, position, material, rotation, arc) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 80, arc || Math.PI * 2), detailMaterials[material]);
    mesh.position.set(...position);
    mesh.rotation.set(...(rotation || [Math.PI / 2, 0, 0]));
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function buildEnvironment() {
    // Softbox reflections make machined metal legible even when a loop is offline.
    const room = new THREE.Scene();
    room.background = new THREE.Color(0x455663);
    const panels = [
      [[0, 6, 0], [9, 0.1, 5], 0xe9eef1],
      [[-5, 2, 0], [0.1, 5, 8], 0x708f9f],
      [[4, 3, -4], [3, 5, 0.1], 0xb8ccd1],
    ];
    for (const [p, s, color] of panels) {
      const panel = new THREE.Mesh(detailGeometry.box, new THREE.MeshBasicMaterial({ color }));
      panel.position.set(...p); panel.scale.set(...s); room.add(panel);
    }
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.05);
    scene.environment = environment.texture;
    pmrem.dispose();
    room.children.forEach(p => p.material.dispose());
  }

  function buildPlatform() {
    const primary = new THREE.Group();
    primary.name = 'industrial-primary';
    const b = detailBatch(primary);
    b.part('box', 'dark', [0, -0.99, 0], [5.9, 0.34, 3.7]);
    b.part('box', 'concrete', [0, -0.85, 0], [5.78, 0.16, 3.58]);
    // Expansion joints and flush service trenches, contained inside the plinth.
    for (let x = -2.5; x <= 2.5; x += 0.5)
      b.part('box', 'seam', [x, -0.766, 0], [0.009, 0.004, 3.55]);
    for (let z = -1.5; z <= 1.5; z += 0.5)
      b.part('box', 'seam', [0, -0.765, z], [5.76, 0.004, 0.009]);
    for (const z of [-1.25, 1.25]) {
      b.part('box', 'dark', [0, -0.754, z], [5.5, 0.016, 0.18]);
      for (let x = -2.65; x < 2.7; x += 0.075)
        b.part('box', 'steel', [x, -0.741, z], [0.016, 0.012, 0.16]);
    }
    // Edge markings, lifting sockets and foundation bolts.
    for (const z of [-1.70, 1.70]) {
      b.part('box', 'yellow', [0, -0.759, z], [5.55, 0.012, 0.024]);
      for (let x = -2.6; x <= 2.6; x += 0.4)
        b.part('bolt', 'steel', [x, -0.735, z * 0.96], [0.022, 0.035, 0.022]);
    }
    for (const x of [-2.95, 2.95]) for (const z of [-1.25, 1.25])
      b.part('box', 'steel', [x, -0.96, z], [0.04, 0.10, 0.22]);
    b.finish();
    addPrimary(primary);

    const secondaryDeck = new THREE.Group();
    secondaryDeck.name = 'industrial-secondary';
    const s = detailBatch(secondaryDeck);
    s.part('box', 'dark', [4.02, -1.32, 0], [5.15, 0.25, 2.9]);
    s.part('box', 'concrete', [4.02, -1.20, 0], [5.05, 0.08, 2.8]);
    for (const z of [-1.29, 1.29]) s.part('box', 'yellow', [4.02, -1.15, z], [4.88, 0.008, 0.026]);
    for (let x = 1.7; x < 6.5; x += 0.4) s.part('box', 'seam', [x, -1.155, 0], [0.008, 0.008, 2.5]);
    s.finish(); addSecondary(secondaryDeck);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x14212b, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1.47;
    ground.receiveShadow = true; addCommon(ground);
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
    const vesselProfile = [
      [0, -0.75], [0.16, -0.73], [0.26, -0.65], [0.31, -0.52],
      [vesselR, -0.35], [vesselR, 0.55], [0.35, 0.69], [0.35, 0.80],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const vessel = new THREE.Mesh(new THREE.LatheGeometry(vesselProfile, 64), vesselMat);
    vessel.name = 'pressure-vessel';
    vessel.receiveShadow = true;
    vessel.castShadow = true;
    addPrimary(vessel);

    // dome (top)
    const domeMat = new THREE.MeshStandardMaterial({ color: COLORS.dome, roughness: 0.25, metalness: 0.6, emissive: 0x080a0e });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(vesselR, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
    dome.position.y = vesselH / 2;
    dome.castShadow = true;
    addPrimary(dome);

    // bottom hemisphere
    // The lower dished head is part of the lathed pressure shell.

    // flanges
    const flangeGeo = new THREE.TorusGeometry(vesselR + 0.04, 0.025, 12, 32);
    for (const fy of [vesselH / 2 - 0.02, -0.35]) {
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
    label.position.set(0, vesselH / 2 + 1.02, 0);
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
    transparent: true, opacity: 0.0, side: THREE.DoubleSide,
    // without this, the transparent dome still writes depth and hides labels when camera goes outside.
    depthWrite: false,
  });

  function buildContainment() {
    const cont = new THREE.Mesh(
      new THREE.SphereGeometry(DIMS.containmentR, 48, 24, Math.PI * 0.15, Math.PI * 0.65, 0, Math.PI / 2),
      contMat,
    );
    cont.position.y = -0.8;
    addPrimary(cont);

    // Alarm envelope only: no permanent transparent sphere obscuring equipment.
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
    m.userData.pipeEndpoints = [curve.getPointAt(0).toArray(), curve.getPointAt(1).toArray()];
    m.userData.pipePath = curve.getPoints(80).map(p => p.toArray());
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
    sgBody.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(ca, 0, sa));
    sgBody.name = 'steam-generator-' + (i + 1);
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
    steamPipe.name = 'sg-steam-neck-' + i;
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
      leg.position.set(sgX + ca * off, sgY - (sgY + 0.55) / 2 - 0.08, sgZ + sa * off);
      g.add(leg);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.015, 0.015), legMat);
      brace.position.set(sgX + ca * off, -0.55, sgZ + sa * off);
      brace.rotation.y = ang;
      g.add(brace);
    }

    // ── MCP (main coolant pump) ──
    const pumpX = ca * pumpDist, pumpZ = sa * pumpDist, pumpY = -0.38;
    const pMat = new THREE.MeshStandardMaterial({ color: COLORS.pump, roughness: 0.30, metalness: 0.60 });
    const pumpBody = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 24), pMat);
    pumpBody.position.set(pumpX, pumpY, pumpZ);
    pumpBody.name = 'mcp-' + (i + 1);
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
    const outwardSign = Math.sign(sa * ca);
    const outX = pdx * outwardSign, outZ = pdz * outwardSign;
    const coldCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sgX - ca * 0.12, sgY - 0.12, sgZ - sa * 0.12),
      new THREE.Vector3(sgX - ca * 0.12 + outX * 0.28, -0.08, sgZ - sa * 0.12 + outZ * 0.28),
      new THREE.Vector3(pumpX + outX * 0.28, -0.28, pumpZ + outZ * 0.28),
      new THREE.Vector3(pumpX + outX * 0.10, pumpY + 0.03, pumpZ + outZ * 0.10),
      new THREE.Vector3(pumpX + ca * 0.10, pumpY, pumpZ + sa * 0.10),
      new THREE.Vector3(pumpX + ca * 0.25 + outX * 0.25, -0.43, pumpZ + sa * 0.25 + outZ * 0.25),
      // Return below and outside the SG saddles, not through their columns.
      new THREE.Vector3(ca * 1.85 + outX * 0.35, -0.48, sa * 1.85 + outZ * 0.35),
      new THREE.Vector3(ca * 0.75 + outX * 0.35, -0.30, sa * 0.75 + outZ * 0.35),
      new THREE.Vector3(ca * (vesselR + 0.05), -0.18, sa * (vesselR + 0.05)),
    ], false, 'catmullrom', 0.25);
    const coldTube = makeTube(coldCurve, coldMat);
    g.add(coldTube);

    // vessel nozzle stubs
    const nozGeo = new THREE.CylinderGeometry(DIMS.pipeR + 0.01, DIMS.pipeR + 0.01, 0.08, 12);
    const nozMat = new THREE.MeshStandardMaterial({ color: COLORS.nozzle, roughness: 0.4, metalness: 0.5 });
    for (const [ny, label] of [[nozzleH, 'hot'], [-0.18, 'cold']]) {
      const n = new THREE.Mesh(nozGeo, nozMat);
      n.position.set(ca * (vesselR + 0.02), ny, sa * (vesselR + 0.02));
      n.name = 'vessel-nozzle-' + i + '-' + label;
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
    const headerY = 0.95;

    const steamMat = new THREE.MeshStandardMaterial({ color: 0xbcc6d3, roughness: 0.45, metalness: 0.35 });
    const feedMat = new THREE.MeshStandardMaterial({ color: 0x5aa0c9, roughness: 0.45, metalness: 0.35 });

    // steam header ring
    const headerCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-headerR, headerY, 0.78),
      new THREE.Vector3(-headerR, headerY, -0.65),
      new THREE.Vector3(-2.40, headerY, -0.85),
      new THREE.Vector3(2.40, headerY, -0.85),
      new THREE.Vector3(headerR, headerY, -0.65),
      new THREE.Vector3(headerR, headerY, 0.78),
    ], true, 'catmullrom', 0.05);
    const header = makeTube(headerCurve, detailMaterials.seam, 0.026);
    addPrimary(header);

    // turbine block
    const turbMat = new THREE.MeshStandardMaterial({ color: 0x768a86, roughness: 0.4, metalness: 0.65 });
    const turbine = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.95, 24), turbMat);
    turbine.position.set(3.55, 0.22, 0.0);
    turbine.name = 'turbine-casing';
    turbine.rotation.z = Math.PI / 2;
    turbine.castShadow = true;
    addSecondary(turbine);
    // Fixed pressure casing; only the shaft should rotate, not the housing.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.32, 20), flangeMat);
    shaft.rotation.z = Math.PI / 2; shaft.position.set(4.1, 0.22, 0);
    addSecondary(shaft); secondary.turbine = shaft;

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
    pBoard.spr.position.set(4.35, 1.14, 0.0);
    addSecondary(pBoard.spr);
    secondary.pBoard = pBoard;

    // condenser block
    const condMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.55, metalness: 0.25 });
    const condenser = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.42, 0.55), condMat);
    condenser.position.set(3.55, -0.55, 0.0);
    condenser.name = 'condenser';
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
    ejBody.name = 'ejector';
    ejBody.rotation.z = Math.PI / 2;
    ejBody.castShadow = true;
    addSecondary(ejBody);

    const ejLabel = makeLabel('ejector / vent', 28);
    ejLabel.scale.set(0.55, 0.18, 1);
    ejLabel.material.opacity = 0.70;
    ejLabel.position.set(ejX, ejY + 0.20, ejZ);
    addSecondary(ejLabel);

    const ejPipe = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.10, -0.34, 0.18),
      new THREE.Vector3(4.18, -0.34, 0.30),
      new THREE.Vector3(ejX, ejY, ejZ),
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
    ejJet.position.set(ejX + 0.16, -0.16, ejZ);
    ejJet.scale.y = 0.01;
    addSecondary(ejJet);
    secondary.ejectorJet = { mesh: ejJet, baseY: -0.16, phase: 1.7 };
    const ventNozzle = makeTube(new THREE.CatmullRomCurve3([
      new THREE.Vector3(ejX + 0.10, ejY, ejZ),
      new THREE.Vector3(ejX + 0.16, -0.28, ejZ),
      new THREE.Vector3(ejX + 0.16, -0.16, ejZ),
    ]), steamMat, 0.014);
    ventNozzle.name = 'ejector-vent-nozzle';
    ventNozzle.userData.openOutlet = 'labelled atmospheric steam vent';
    addSecondary(ventNozzle);

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
    water.position.set(pondX, pondY + 0.17, pondZ);
    water.rotation.x = -Math.PI / 2;
    addSecondary(water);

    // cooling pipes: condenser <-> pond (closed loop)
    const toPond = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.10, -0.55, 0.18),
      new THREE.Vector3(4.32, -0.65, 0.35),
      new THREE.Vector3(4.50, -0.84, 0.35),
      new THREE.Vector3(pondX - 0.78, -1.00, 0.20),
    ]);
    addSecondary(makeTube(toPond, cwMat, 0.014));

    const fromPond = new THREE.CatmullRomCurve3([
      new THREE.Vector3(pondX - 0.78, -1.00, -0.20),
      new THREE.Vector3(4.50, -0.84, -0.35),
      new THREE.Vector3(4.32, -0.65, -0.35),
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
        const y = pondY + 0.18;

        const n = new THREE.Mesh(nozGeo, nozMat);
        n.position.set(x, y - 0.02, z);
        n.name = 'spray-nozzle-' + ix + '-' + iz;
        n.castShadow = true;
        addSecondary(n);

        const j = new THREE.Mesh(jetGeo, jetMat);
        j.position.set(x, y + 0.05, z);
        j.scale.y = 0.08;
        addSecondary(j);

        secondary.sprayJets.push({ mesh: j, baseY: y - 0.005, phase: (ix * 17 + iz * 29) * 0.17 });
      }
    }

    // main steam line: header -> turbine
    const steamMainCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.60, headerY, -0.90),
      new THREE.Vector3(2.20, headerY, -0.90),
      new THREE.Vector3(2.90, headerY, -0.90),
      new THREE.Vector3(3.10, 0.55, -0.60),
      new THREE.Vector3(3.10, 0.22, 0.0),
    ]);
    secondary.curves.push({ curve: steamMainCurve, kind: 'steam' });
    addSecondary(makeTube(steamMainCurve, steamMat, 0.020));

    // exhaust steam: turbine -> condenser
    const exhaustCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(3.60, 0.22, 0.12),
      new THREE.Vector3(3.60, -0.20, 0.15),
      new THREE.Vector3(3.60, -0.55, 0.15),
    ]);
    secondary.curves.push({ curve: exhaustCurve, kind: 'steam' });
    addSecondary(makeTube(exhaustCurve, steamMat, 0.018));

    // Feedwater terminates at the paired, labelled island boundary below.

    // condenser -> deaerator -> feedwater pumps (x3) -> feed header
    const deaMat = new THREE.MeshStandardMaterial({ color: 0x7b8794, roughness: 0.45, metalness: 0.35 });

    const dea = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.78, 22), deaMat);
    dea.position.set(2.72, -0.55, 0.95);
    dea.name = 'deaerator';
    dea.rotation.z = Math.PI / 2;
    dea.castShadow = true;
    addSecondary(dea);

    const deaLabel = makeLabel('deaer', 40);
    deaLabel.scale.set(0.9, 0.24, 1);
    deaLabel.material.opacity = 0.75;
    deaLabel.position.set(2.72, -0.20, 0.95);
    addSecondary(deaLabel);

    const condOut = new THREE.Vector3(3.00, -0.55, 0.0);
    const deaIn = new THREE.Vector3(3.11, -0.55, 0.95);
    const deaOut = new THREE.Vector3(2.33, -0.55, 0.95);

    const condToDea = new THREE.CatmullRomCurve3([
      condOut,
      new THREE.Vector3(2.95, -0.55, 0.25),
      deaIn,
    ]);
    secondary.curves.push({ curve: condToDea, kind: 'feed' });
    addSecondary(makeTube(condToDea, feedMat, 0.016));

    const suction = new THREE.Vector3(2.40, -0.55, 0.0);
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
      const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.06, 8), mat);
      spindle.position.set(x, y + 0.035, z);
      addSecondary(spindle);

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

      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.10, 12), gaugeBodyMat);
      stem.position.set(x, y + 0.025, z);
      addSecondary(stem);
    }

    function addThermocouple(x, y, z) {
      const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.10, 12), tcMat);
      probe.position.set(x, y + 0.04, z);
      probe.castShadow = true;
      addSecondary(probe);

      const head = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.018, 0.018), tcMat);
      head.position.set(x, y + 0.095, z);
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
      body.name = 'feed-pump-' + pi;
      body.rotation.z = Math.PI / 2;
      body.castShadow = true;
      addSecondary(body);

      const imp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12), impMat);
      imp.position.set(pumpXs - 0.10, pumpY, z);
      imp.rotation.z = Math.PI / 2;
      imp.castShadow = true;
      addSecondary(imp);
      secondary.fwPumps.push(imp);

      const sIn = new THREE.Vector3(pumpXs + 0.15, pumpY, z);
      const sCurve = new THREE.CatmullRomCurve3([
        suction,
        new THREE.Vector3(2.40, pumpY, z),
        sIn,
      ]);
      secondary.curves.push({ curve: sCurve, kind: 'feed' });
      addSecondary(makeTube(sCurve, feedMat, 0.010));

      // suction isolation valve
      const vS = addIsoValve(pumpXs + 0.24, pumpY, z);

      const sOut = new THREE.Vector3(pumpXs - 0.15, pumpY, z);
      const dCurve = new THREE.CatmullRomCurve3([
        sOut,
        new THREE.Vector3(1.50, pumpY, z),
        new THREE.Vector3(1.45, -0.34, z),
        new THREE.Vector3(1.65, -0.23, z),
        discharge,
      ], false, 'catmullrom', 0.12);
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
      new THREE.Vector3(2.60, -0.10, -0.70),
      new THREE.Vector3(2.25, 0.20, -0.90),
      new THREE.Vector3(1.60, 0.20, -0.90),
    ]);
    secondary.curves.push({ curve: toHeader, kind: 'feed' });
    addSecondary(makeTube(toHeader, feedMat, 0.016));

    // The SG steam rack belongs to the reactor island. The turbine view shows
    // its incoming steam / outgoing feedwater at the island boundary instead
    // of floating disconnected loops from hidden primary equipment.
    for (const L of loopObjs) {
      const headerPoint = new THREE.Vector3(Math.sign(L.steamOut.x) * headerR, headerY, L.steamOut.z * 1.35);
      const steamCurve = new THREE.CatmullRomCurve3([
        L.steamOut.clone(),
        new THREE.Vector3(L.steamOut.x, headerY, L.steamOut.z),
        headerPoint,
      ]);
      addPrimary(makeTube(steamCurve, steamMat, 0.022));
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
    const bodyGeo = new THREE.BoxGeometry(0.075, 0.035, 0.13);
    const wheelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.014, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x809397, roughness: 0.55, metalness: 0.4 });
    for (let i = 0; i < 10; i++) {
      const mesh = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat); mesh.add(body);
      for (const x of [-0.042, 0.042]) for (const z of [-0.045, 0.045]) {
        const wheel = new THREE.Mesh(wheelGeo, detailMaterials.dark);
        wheel.rotation.z = Math.PI / 2; wheel.position.set(x, -0.018, z); mesh.add(wheel);
      }
      addPrimary(mesh);
      caravanMeshes.push({ mesh, phase: (i / 10) * Math.PI * 2, spd: 1.0 });
    }
  }

  // ── machined equipment and service infrastructure ──────────────

  function buildMechanicalDetails() {
    const g = new THREE.Group(); g.name = 'pressure-vessel-detail';
    const b = detailBatch(g);
    // Header trestles terminate on the foundation instead of floating in space.
    for (const x of [-2.68, 2.68]) for (const z of [-0.65, 0.65]) {
      b.part('box', 'dark', [x, 0.068, z], [0.045, 1.676, 0.045]);
      b.part('box', 'steel', [x, -0.74, z], [0.15, 0.025, 0.15]);
      b.part('box', 'steel', [Math.sign(x) * 2.60, 0.915, z], [0.30, 0.018, 0.10]);
    }
    // Forged head flange with visible studs, nuts and a dark gasket joint.
    b.part('cylinder', 'steel', [0, 0.76, 0], [0.405, 0.10, 0.405]);
    b.part('cylinder', 'seam', [0, 0.80, 0], [0.408, 0.012, 0.408]);
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16, x = Math.cos(a) * 0.373, z = Math.sin(a) * 0.373;
      b.part('cylinder', 'dark', [x, 0.82, z], [0.010, 0.16, 0.010]);
      b.part('bolt', 'steel', [x, 0.874, z], [0.022, 0.032, 0.022]);
      b.part('bolt', 'steel', [x, 0.70, z], [0.022, 0.025, 0.022]);
    }
    for (const y of [-0.45, -0.10, 0.32, 0.58]) ring(g, 0.324, 0.006, [0, y, 0], 'seam');
    // Bearing ring and four structural columns, grounded in concrete footings.
    ring(g, 0.43, 0.065, [0, -0.40, 0], 'dark');
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2, x = Math.cos(a) * 0.42, z = Math.sin(a) * 0.42;
      b.part('box', 'dark', [x, -0.59, z], [0.11, 0.35, 0.11]);
      b.part('box', 'steel', [x, -0.744, z], [0.20, 0.024, 0.20]);
    }
    // CRDM motor collars, terminal boxes and cable-routing crown.
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8, r = i % 2 === 0 ? 0.14 : 0.22;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      for (const y of [1.20, 1.46, 1.55]) b.part('cylinder', 'dark', [x, y, z], [0.029, 0.038, 0.029]);
      b.part('box', 'steel', [x, 1.58, z], [0.048, 0.055, 0.048]);
    }
    ring(g, 0.255, 0.016, [0, 1.58, 0], 'dark');
    // Rear half-annulus maintenance deck: open front keeps the vessel readable.
    const deck = new THREE.Mesh(new THREE.RingGeometry(0.48, 0.80, 64, 1, 0, Math.PI), detailMaterials.dark);
    deck.rotation.x = -Math.PI / 2; deck.position.y = 0.54; deck.receiveShadow = true; g.add(deck);
    for (const y of [0.73, 0.93]) ring(g, 0.79, 0.009, [0, y, 0], 'yellow', [-Math.PI / 2, 0, 0], Math.PI);
    for (let i = 0; i <= 10; i++) {
      const a = i * Math.PI / 10, x = Math.cos(a) * 0.79, z = -Math.sin(a) * 0.79;
      b.part('cylinder', 'yellow', [x, 0.74, z], [0.011, 0.40, 0.011]);
    }
    for (let i = 0; i <= 3; i++) {
      const a = i * Math.PI / 3;
      b.part('box', 'dark', [Math.cos(a) * 0.79, -0.11, -Math.sin(a) * 0.79], [0.03, 1.28, 0.03]);
    }
    // Access ladder on the rear, with evenly spaced anti-slip rungs.
    for (const x of [-0.12, 0.12]) b.part('box', 'steel', [x, -0.10, -0.85], [0.022, 1.35, 0.022]);
    for (let y = -0.65; y <= 0.5; y += 0.12) b.part('box', 'steel', [0, y, -0.85], [0.26, 0.018, 0.038]);
    b.finish(); addPrimary(g);

    for (let i = 0; i < loops.length; i++) {
      const L = loops[i], ca = Math.cos(L.ang), sa = Math.sin(L.ang);
      const detail = new THREE.Group(); detail.name = 'loop-detail-' + (i + 1);
      // SG local X axis follows the vessel's real shell axis.
      detail.position.copy(L.sg.position); detail.rotation.y = -L.ang;
      const d = detailBatch(detail);
      for (const x of [-0.38, 0.38]) {
        d.part('box', 'dark', [x, -0.52, 0], [0.13, 0.66, 0.28]);
        d.part('box', 'steel', [x, -0.86, 0], [0.28, 0.045, 0.42]);
        d.part('box', 'dark', [x, -0.18, 0], [0.16, 0.12, 0.37]);
        for (const z of [-0.15, 0.15]) d.part('bolt', 'steel', [x, -0.83, z], [0.016, 0.025, 0.016]);
      }
      for (const x of [-0.44, -0.22, 0, 0.22, 0.44])
        ring(detail, 0.182, 0.006, [x, 0, 0], 'seam', [0, Math.PI / 2, 0]);
      for (const x of [-0.47, 0.47]) {
        ring(detail, 0.183, 0.018, [x, 0, 0], 'steel', [0, Math.PI / 2, 0]);
        for (let j = 0; j < 16; j++) {
          const a = j * Math.PI / 8;
          d.part('bolt', 'steel', [x, Math.cos(a) * 0.196, Math.sin(a) * 0.196], [0.012, 0.03, 0.012], [0, 0, Math.PI / 2]);
        }
      }
      // Inspection hatch and steam isolation handwheel.
      d.part('cylinder', 'steel', [0.1, 0.17, 0], [0.082, 0.07, 0.082]);
      d.part('cylinder', 'dark', [0, 0.42, 0], [0.045, 0.10, 0.045]);
      d.part('cylinder', 'steel', [0, 0.51, 0], [0.009, 0.13, 0.009]);
      ring(detail, 0.07, 0.009, [0, 0.57, 0], 'yellow');
      for (const rot of [0, Math.PI / 2]) d.part('box', 'yellow', [0, 0.57, 0], [0.14, 0.008, 0.008], [0, rot, 0]);
      d.finish(); L.group.add(detail);

      const pumpDetail = new THREE.Group(); pumpDetail.name = 'pump-detail-' + (i + 1);
      const p = detailBatch(pumpDetail), x = ca * DIMS.pumpDist, z = sa * DIMS.pumpDist;
      p.part('box', 'concrete', [x, -0.69, z], [0.42, 0.14, 0.42]);
      p.part('box', 'steel', [x, -0.595, z], [0.32, 0.045, 0.32]);
      p.part('cylinder', 'dark', [x, -0.53, z], [0.13, 0.10, 0.13]);
      p.part('box', 'dark', [x + 0.10, -0.06, z], [0.09, 0.11, 0.09]);
      for (let j = 0; j < 20; j++) {
        const a = j * Math.PI / 10;
        p.part('box', 'steel', [x + Math.cos(a) * 0.071, -0.12, z + Math.sin(a) * 0.071], [0.025, 0.23, 0.006], [0, -a, 0]);
      }
      for (let j = 0; j < 8; j++) {
        const a = j * Math.PI / 4;
        p.part('bolt', 'steel', [x + Math.cos(a) * 0.13, -0.275, z + Math.sin(a) * 0.13], [0.012, 0.03, 0.012]);
      }
      p.finish(); L.group.add(pumpDetail);
      // Pipe collars align to local curve tangents rather than arbitrary world axes.
      for (const curve of [L.hotCurve, L.coldCurve]) for (const t of [0.06, 0.35, 0.72, 0.94]) {
        const c = ring(L.group, DIMS.pipeR + 0.01, 0.012, curve.getPointAt(t).toArray(), 'steel', [0, 0, 0]);
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(t));
      }
    }

    const s = new THREE.Group(); s.name = 'turbine-hall-detail';
    const d = detailBatch(s);
    // Turbine split casing, circumferential ribs and bolted longitudinal joint.
    for (let x = 3.12; x < 3.99; x += 0.09) ring(s, 0.206, 0.014, [x, 0.22, 0], 'steel', [0, Math.PI / 2, 0]);
    for (const z of [-0.20, 0.20]) {
      d.part('box', 'steel', [3.55, 0.22, z], [0.98, 0.035, 0.065]);
      for (let x = 3.13; x < 4.0; x += 0.08) d.part('bolt', 'dark', [x, 0.25, z], [0.012, 0.03, 0.012]);
    }
    for (const x of [3.17, 3.90]) {
      d.part('box', 'dark', [x, -0.02, 0], [0.15, 0.08, 0.86]);
      for (const z of [-0.38, 0.38]) {
        d.part('box', 'dark', [x, -0.54, z], [0.10, 1.02, 0.10]);
        d.part('box', 'concrete', [x, -1.07, z], [0.24, 0.16, 0.24]);
      }
    }
    // Bridge over the pond and cooling lines, rather than placing generator
    // pedestals through the submerged distributor and condenser connections.
    for (const x of [4.2, 4.52]) {
      d.part('box', 'dark', [x, -0.04, 0], [0.15, 0.08, 1.56]);
      for (const z of [-0.72, 0.72]) {
        d.part('box', 'dark', [x, -0.55, z], [0.10, 1.02, 0.10]);
        d.part('box', 'concrete', [x, -1.08, z], [0.22, 0.15, 0.22]);
      }
    }
    // Generator stator cooling fins and terminal enclosure.
    for (let i = 0; i < 28; i++) {
      const a = i * Math.PI / 14;
      d.part('box', 'dark', [4.35, 0.22 + Math.cos(a) * 0.23, Math.sin(a) * 0.23], [0.56, 0.025, 0.017], [a, 0, 0]);
    }
    d.part('box', 'dark', [4.38, 0.51, 0], [0.28, 0.15, 0.22]);
    for (const x of [4.04, 4.65]) ring(s, 0.22, 0.024, [x, 0.22, 0], 'steel', [0, Math.PI / 2, 0]);
    // Condenser tube-sheet access doors and structural ribs.
    for (let x = 3.05; x < 4.1; x += 0.14) d.part('box', 'steel', [x, -0.55, 0], [0.02, 0.45, 0.59]);
    for (const x of [3.27, 3.80]) {
      d.part('cylinder', 'steel', [x, -0.55, 0.295], [0.14, 0.035, 0.14], [Math.PI / 2, 0, 0]);
      ring(s, 0.13, 0.012, [x, -0.55, 0.32], 'dark', [0, 0, 0]);
    }
    // Raised pond walls, supply manifolds, grounded pipe trestles.
    for (const z of [-0.55, 0.55]) d.part('box', 'concrete', [5.35, -1.01, z], [1.94, 0.25, 0.08]);
    for (const x of [4.40, 6.30]) d.part('box', 'concrete', [x, -1.01, 0], [0.08, 0.25, 1.12]);
    // Every spray nozzle is fed by a submerged distribution branch.
    for (let iz = 0; iz < 5; iz++) {
      const z = ((iz + 0.5) / 5 - 0.5) * 0.84;
      const branch = makeTube(new THREE.LineCurve3(new THREE.Vector3(4.65, -0.97, z), new THREE.Vector3(6.05, -0.97, z)), detailMaterials.steel, 0.014);
      branch.name = 'pond-distributor-' + iz; s.add(branch);
    }
    const pondHeader = makeTube(new THREE.LineCurve3(new THREE.Vector3(4.65, -0.97, -0.336), new THREE.Vector3(4.65, -0.97, 0.336)), detailMaterials.steel, 0.014);
    pondHeader.name = 'pond-header'; s.add(pondHeader);
    const pondSupply = new THREE.CatmullRomCurve3([
      new THREE.Vector3(4.57, -1.0, 0.2), new THREE.Vector3(4.61, -0.97, 0.2), new THREE.Vector3(4.65, -0.97, 0.2),
    ]);
    s.add(makeTube(pondSupply, detailMaterials.steel, 0.014));
    const drain = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 16), detailMaterials.dark);
    drain.position.set(4.57, -0.99, -0.20); drain.name = 'pond-intake-strainer'; s.add(drain);
    for (const x of [2.45, 2.95]) d.part('box', 'dark', [x, -0.94, 0.95], [0.12, 0.42, 0.26]);
    for (const x of [2.0, 2.5]) for (const z of [-0.55, 0, 0.55])
      d.part('box', 'dark', [x, -0.93, z], [0.07, 0.44, 0.18]);
    d.finish(); addSecondary(s);
  }

  function buildIslandConnections() {
    // Open flanged ports on labelled section boundaries represent the same
    // S1/F1 lines in the two isolated views; they are not capped pipe ends.
    function boundary(add, x, z, floor, feedY, title) {
      const g = new THREE.Group(); g.name = 'boundary-' + title;
      const b = detailBatch(g);
      for (const dz of [-0.27, 0.27]) b.part('box', 'yellow', [x, (1.20 + floor) / 2, z + dz], [0.025, 1.20 - floor, 0.025]);
      for (const y of [floor, 1.20]) b.part('box', 'yellow', [x, y, z], [0.025, 0.025, 0.56]);
      for (const [y, id] of [[0.95, 'S1'], [feedY, 'F1']]) {
        const flange = ring(g, 0.075, 0.012, [x, y, z], 'steel', [0, Math.PI / 2, 0]);
        flange.name = title + '-' + id;
        // Port coordinates are local to the positioned/rotated flange.
        flange.userData.boundaryPort = [0, 0, 0];
        const tag = makeLabel(id === 'S1' ? 'S1 / STEAM' : 'F1 / FEED', 34);
        tag.scale.set(0.72, 0.18, 1); tag.position.set(x, y - 0.16, z); g.add(tag);
      }
      const label = makeLabel(title + ' / CONT.', 30);
      label.scale.set(1.35, 0.34, 1); label.position.set(x, 1.38, z); g.add(label);
      b.finish(); add(g);
    }
    boundary(addPrimary, 2.90, 1.0, -0.76, 0.50, 'TURBINE HALL');
    boundary(addSecondary, 1.60, -0.90, -1.15, 0.20, 'REACTOR ISLAND');
    const steam = new THREE.CatmullRomCurve3([
      new THREE.Vector3(2.55, 0.95, 0.65), new THREE.Vector3(2.70, 0.95, 1.0), new THREE.Vector3(2.90, 0.95, 1.0),
    ], false, 'catmullrom', 0.1);
    addPrimary(makeTube(steam, detailMaterials.steel, 0.026));
    const feedMat = new THREE.MeshStandardMaterial({color: COLORS.coldPipe, roughness: 0.42, metalness: 0.45});
    const feedLoop = new THREE.CatmullRomCurve3([
      [-2.55, -0.30, -1.05], [2.55, -0.30, -1.05],
      [2.55, -0.30, 1.05], [-2.55, -0.30, 1.05],
    ].map(p => new THREE.Vector3(...p)), true, 'catmullrom', 0.03);
    addPrimary(makeTube(feedLoop, feedMat, 0.023));
    addPrimary(makeTube(new THREE.CatmullRomCurve3([
      new THREE.Vector3(2.55, -0.30, 1.0), new THREE.Vector3(2.77, -0.15, 1.0),
      new THREE.Vector3(2.77, 0.50, 1.0), new THREE.Vector3(2.90, 0.50, 1.0),
    ], false, 'catmullrom', 0.1), feedMat, 0.023));
    for (const L of loops) {
      const ca = Math.cos(L.ang), sa = Math.sin(L.ang), side = Math.sign(L.sg.position.z);
      const inlet = new THREE.Vector3(L.sg.position.x + ca * 0.2, 0.15, L.sg.position.z + sa * 0.2 + side * 0.18);
      addPrimary(makeTube(new THREE.CatmullRomCurve3([
        inlet, new THREE.Vector3(inlet.x, -0.18, inlet.z + side * 0.12),
        new THREE.Vector3(inlet.x, -0.30, side * 1.05),
      ], false, 'catmullrom', 0.1), feedMat, 0.016));
      const flange = ring(L.group, 0.032, 0.008, inlet.toArray(), 'steel', [0, 0, 0]);
      flange.name = 'sg-feed-nozzle';
    }
  }

  // ── build scene ────────────────────────────────────────────────

  buildEnvironment();
  buildPlatform();
  buildVessel();
  buildControlRods();
  buildContainment();
  for (let i = 0; i < 4; i++) loops.push(buildLoop(i));
  buildSecondary(loops);
  buildCaravans();
  buildMechanicalDetails();
  buildIslandConnections();

  // ── view switching (primary vs secondary) ─────────────────────

  let viewMode = (localStorage.getItem('reactor_3d_view') || 'primary');

  function setBtnActive(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-active', !!on);
  }

  function applyView(mode) {
    renderer.shadowMap.needsUpdate = true;
    viewMode = (mode === 'secondary') ? 'secondary' : 'primary';
    localStorage.setItem('reactor_3d_view', viewMode);

    for (const o of commonObjs) o.visible = true;
    for (const o of primaryObjs) o.visible = (viewMode === 'primary');
    for (const o of secondaryObjs) o.visible = (viewMode === 'secondary');

    setBtnActive('view-primary', viewMode === 'primary');
    setBtnActive('view-secondary', viewMode === 'secondary');

    if (viewMode === 'secondary') {
      orbit.target.set(4.0, -0.20, 0.0);
      orbit.radius = 9.6;
      orbit.theta = Math.PI * 0.42;
      orbit.phi = Math.PI * 0.30;
    } else {
      orbit.target.set(0.0, 0.0, 0.0);
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

      const nextRodPct = st.control_rod_pct || 0;
      if (nextRodPct !== reactorState.rodPct) renderer.shadowMap.needsUpdate = true;
      reactorState.rodPct = nextRodPct;
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
        contMat.opacity = 0.0;
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
    // Keep the equipment framed on narrow canvas hosts without changing the UI.
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(38) / 2) * Math.max(1, 1.45 / camera.aspect)));
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
      cv.mesh.position.set(Math.cos(a) * 2.72, -0.705, Math.sin(a) * 1.50);
      cv.mesh.lookAt(Math.cos(a + 0.01) * 2.72, -0.705, Math.sin(a + 0.01) * 1.50);
    }

    renderer.render(scene, camera);
  }
  animate();
})();
