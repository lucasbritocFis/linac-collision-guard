import { useState, useEffect, useRef, useCallback, useMemo } from "react";

function loadThree() {
  return new Promise((res, rej) => {
    if (window.THREE) return res(window.THREE);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    s.onload = () => res(window.THREE);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   GEOMETRY CONSTANTS – Varian TrueBeam Edge / PerfectPitch 6DoF
   ═══════════════════════════════════════════════════════════════════ */
const SAD = 100;
const STAND_Z = -85;
const CLEARANCE = 40;
const HEAD_R1 = 15, HEAD_R2 = 32, HEAD_H = 45;
const CW = 53, CT = 5, C_YOFF = 15;
const COUCH_Z_MIN = -20, COUCH_Z_MAX = 200;

const LIMITS = {
  lat:  { min: -24.5, max: 24.5,  label: "LATERAL (X)" },
  vert: { min: -57,   max: 40.5,  label: "VERTICAL (Y)" },
  lng:  { min: -51.5, max: 93.5,  label: "LONGIT. (Z)" },
  rm:   { min: -95,   max: 95,    label: "MESA ROT." },
};

const FIELD_COLORS = [
  { hex: 0x3B82F6, css: "#3B82F6" }, { hex: 0x10B981, css: "#10B981" },
  { hex: 0xF59E0B, css: "#F59E0B" }, { hex: 0xA855F7, css: "#A855F7" },
  { hex: 0xEF4444, css: "#EF4444" }, { hex: 0x06B6D4, css: "#06B6D4" },
  { hex: 0xEC4899, css: "#EC4899" }, { hex: 0xF97316, css: "#F97316" },
];
const COL_RED = { hex: 0xEF4444, css: "#EF4444" };
const COL_WARN = { hex: 0xF59E0B, css: "#F59E0B" };

/* ═══════════════════════════════════════════════════════════════════ */
function rotZ(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return ([x, y, z]) => [c*x - s*y, s*x + c*y, z]; }
function rotY(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return ([x, y, z]) => [c*x + s*z, y, -s*x + c*z]; }

function getHeadPoints(gDeg) {
  const pts = [];
  for (let f = 0; f <= 1; f += 0.2) {
    const r = HEAD_R1 + (HEAD_R2 - HEAD_R1) * f, y = CLEARANCE + HEAD_H * f;
    for (let a = 0; a < 360; a += 20) pts.push([r * Math.cos(a * Math.PI / 180), y, r * Math.sin(a * Math.PI / 180)]);
  }
  return pts.map(rotZ(gDeg));
}

function checkCollision(g, lat, lng, vert, rm, prx, pry, plen) {
  const headPts = getHeadPoints(g);
  const ytop = -C_YOFF + vert, couchZ = -lng;
  let dc = Infinity, dp = Infinity, ds = Infinity;
  const inv = rotY(-rm);
  
  for (const pt of headPts) {
    const [nx, ny, nz] = inv([pt[0] - lat, pt[1] - ytop, pt[2] - couchZ]);
    const dx = Math.max(-CW/2 - nx, 0, nx - CW/2), dy = Math.max(-CT - ny, 0, ny), dz = Math.max(COUCH_Z_MIN - nz, 0, nz - COUCH_Z_MAX);
    const dM = (dx === 0 && dy === 0 && dz === 0) ? -1 : Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dM < dc) dc = dM;
    if (plen > 0 && prx > 0 && pry > 0) {
      const px = nx, py = ny - pry, pzC = COUCH_Z_MIN + plen / 2;
      const dzP = Math.max(0, Math.abs(nz - pzC) - plen / 2);
      let bc = Infinity;
      for (let t = 0; t < 32; t++) { const a = (t/32)*2*Math.PI; bc = Math.min(bc, (px-prx*Math.cos(a))**2+(py-pry*Math.sin(a))**2); }
      const ins = (px/prx)**2 + (py/pry)**2 < 1;
      const dcCyl = Math.sqrt(bc) * (ins ? -1 : 1);
      const dPac = dzP === 0 ? dcCyl : dcCyl < 0 ? dzP : Math.sqrt(dcCyl**2 + dzP**2);
      if (dPac < dp) dp = dPac;
    }
  }
  const applyT = (x, z) => rotY(rm)([x, 0, z + couchZ]);
  for (const c of [applyT(-CW/2, COUCH_Z_MIN), applyT(CW/2, COUCH_Z_MIN)]) { if (c[2] - STAND_Z < ds) ds = c[2] - STAND_Z; }
  const dm = Math.min(dc, dp, ds);
  return { dc, dp, ds, dm, st: dm <= 0 ? "col" : dm <= 3 ? "warn" : "ok" };
}

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function parseF(val) { const n = parseFloat(val); return isNaN(n) ? 0 : n; }

/* ═══════════════════════════════════════════════════════════════════
   COMPONENT
   ═══════════════════════════════════════════════════════════════════ */
export default function LinacCollisionGuard() {
  const mountRef = useRef(null);
  const S = useRef({ renderer: null, scene: null, camera: null, anim: null, refs: {} });
  
  // Responsive State
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 800);
    handleResize(); // Init
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const camR = useRef({ theta: 0.6, phi: 0.3, dist: isMobile ? 500 : 380 });
  const dragR = useRef({ on: false, x: 0, y: 0 });

  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("static");
  const [iso, setIso] = useState({ lat: 0, lng: 0, vert: 0 });
  const [patient, setPatient] = useState({ rx: 18, ry: 13, len: 170, show: true });
  const [beams, setBeams] = useState([
    { id: 1, g: 0, rm: 0 }, { id: 2, g: 90, rm: 0 },
    { id: 3, g: 180, rm: 0 }, { id: 4, g: 270, rm: 0 },
  ]);
  const [arcs, setArcs] = useState([{ id: 1, s: 181, e: 179, rm: 0 }]);
  const [activeField, setActiveField] = useState(null);
  const nextId = useRef(10);

  /* ── AUTO-EVALUATE ── */
  const results = useMemo(() => {
    const prx = patient.show ? parseF(patient.rx) : 0;
    const pry = patient.show ? parseF(patient.ry) : 0;
    const plen = patient.show ? parseF(patient.len) : 0;
    const iLat = parseF(iso.lat), iLng = parseF(iso.lng), iVert = parseF(iso.vert);

    if (mode === "static") {
      return beams.map(b => ({ id: b.id, g: parseF(b.g), rm: parseF(b.rm),
        ...checkCollision(parseF(b.g), iLat, iLng, iVert, parseF(b.rm), prx, pry, plen) }));
    } else {
      return arcs.map(a => {
        let minDm = Infinity, worst = "ok", minDc = Infinity, minDp = Infinity;
        const start = parseF(a.s), end = parseF(a.e), rMesa = parseF(a.rm);
        for (let i = 0; i <= 40; i++) {
          const deg = start + (((end - start) % 360 + 360) % 360 || 360) * (i / 40);
          const r = checkCollision(deg, iLat, iLng, iVert, rMesa, prx, pry, plen);
          if (r.dm < minDm) minDm = r.dm; if (r.dc < minDc) minDc = r.dc; if (r.dp < minDp) minDp = r.dp;
          if (r.st === "col") worst = "col"; else if (r.st === "warn" && worst !== "col") worst = "warn";
        }
        return { id: a.id, s: start, e: end, rm: rMesa, dm: minDm, dc: minDc, dp: minDp, st: worst };
      });
    }
  }, [beams, arcs, mode, iso, patient]);

  const worstStatus = results.some(r => r.st === "col") ? "col" : results.some(r => r.st === "warn") ? "warn" : "ok";

  /* ── INIT THREE.JS ── */
  useEffect(() => {
    let dead = false;
    loadThree().then(THREE => {
      if (dead || !mountRef.current) return;
      const el = mountRef.current, W = el.clientWidth, H = el.clientHeight;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(W, H); renderer.setClearColor(0x080C14, 1);
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x080C14, 600, 1000);
      scene.add(new THREE.AmbientLight(0x334466, 1.0));
      const dir = new THREE.DirectionalLight(0xFFFFFF, 1.1); dir.position.set(80, 200, 120); scene.add(dir);
      const rim = new THREE.DirectionalLight(0x4488FF, 0.35); rim.position.set(-100, 50, -80); scene.add(rim);
      const camera = new THREE.PerspectiveCamera(42, W / H, 1, 1500);

      const mat = (c, op = 1, ro = 0.5) => new THREE.MeshStandardMaterial({ color: c, transparent: op < 1, opacity: op, roughness: ro, metalness: 0.1, side: THREE.DoubleSide });
      const R = S.current.refs;

      const stand = new THREE.Mesh(new THREE.BoxGeometry(160, 240, 60), mat(0x1E2433)); stand.position.set(0, 20, STAND_Z - 30); scene.add(stand);

      R.gantryGrp = new THREE.Group();
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(62, 62, 42, 48), mat(0x222838)); rotor.rotation.x = Math.PI/2; rotor.position.z = STAND_Z; R.gantryGrp.add(rotor);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(62, 2, 16, 48), new THREE.MeshStandardMaterial({ color: 0x3B82F6, emissive: 0x1D4ED8, emissiveIntensity: 0.3 }));
      ring.position.z = STAND_Z + 22; R.gantryGrp.add(ring);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(46, 80, Math.abs(STAND_Z)), mat(0x2A3044)); arm.position.set(0, CLEARANCE + HEAD_H + 40, STAND_Z / 2); R.gantryGrp.add(arm);
      R.headMesh = new THREE.Mesh(new THREE.CylinderGeometry(HEAD_R2, HEAD_R1, HEAD_H, 48), new THREE.MeshStandardMaterial({ color: 0x3B82F6, roughness: 0.15, metalness: 0.6, emissive: 0x1a3a6a, emissiveIntensity: 0.15 }));
      R.headMesh.position.set(0, CLEARANCE + HEAD_H / 2, 0); R.gantryGrp.add(R.headMesh);
      scene.add(R.gantryGrp);

      R.couchGrp = new THREE.Group();
      R.couchGrp.add(new THREE.Mesh(new THREE.BoxGeometry(CW, CT, COUCH_Z_MAX - COUCH_Z_MIN), mat(0x1A1F2E, 0.92, 0.25)).translateZ((COUCH_Z_MAX + COUCH_Z_MIN) / 2));
      for (const s of [-1, 1]) { const rl = new THREE.Mesh(new THREE.BoxGeometry(2, 2, COUCH_Z_MAX - COUCH_Z_MIN), new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.2 })); rl.position.set(s*(CW/2-1), -CT/2, (COUCH_Z_MAX+COUCH_Z_MIN)/2); R.couchGrp.add(rl); }
      scene.add(R.couchGrp);

      R.patGrp = new THREE.Group();
      R.patMesh = new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,32), new THREE.MeshStandardMaterial({ color: 0x22D3EE, transparent: true, opacity: 0.3, roughness: 0.6, side: THREE.DoubleSide }));
      R.patMesh.rotation.x = Math.PI/2; R.patGrp.add(R.patMesh);
      R.patWire = new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,16), new THREE.MeshBasicMaterial({ color: 0x22D3EE, wireframe: true, transparent: true, opacity: 0.12 }));
      R.patWire.rotation.x = Math.PI/2; R.patGrp.add(R.patWire);
      scene.add(R.patGrp);

      R.beamVizGrp = new THREE.Group(); scene.add(R.beamVizGrp);
      R.ghostGrp = new THREE.Group(); scene.add(R.ghostGrp);

      scene.add(new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xFACC15 })));
      for (const ax of ["x","y","z"]) { const p=[new THREE.Vector3(), new THREE.Vector3()]; p[0][ax]=-7; p[1][ax]=7; scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color: 0xFACC15, transparent: true, opacity: 0.4 }))); }

      const grid = new THREE.GridHelper(500, 50, 0x1A2540, 0x111828); grid.position.y = -C_YOFF - 20; scene.add(grid);

      S.current.renderer = renderer; S.current.scene = scene; S.current.camera = camera;
      const tick = () => { S.current.anim = requestAnimationFrame(tick); const c = camR.current;
        camera.position.set(c.dist*Math.sin(c.theta)*Math.cos(c.phi), c.dist*Math.sin(c.phi), c.dist*Math.cos(c.theta)*Math.cos(c.phi));
        camera.lookAt(0,-10,10); renderer.render(scene, camera); };
      tick();
      const onResize = () => { if(!mountRef.current) return; const w=mountRef.current.clientWidth, h=mountRef.current.clientHeight; renderer.setSize(w,h); camera.aspect=w/h; camera.updateProjectionMatrix(); };
      window.addEventListener("resize", onResize); S.current._onResize = onResize;
      setReady(true);
    });
    return () => { dead = true; cancelAnimationFrame(S.current.anim);
      if (S.current._onResize) window.removeEventListener("resize", S.current._onResize);
      if (S.current.renderer && mountRef.current) { try { mountRef.current.removeChild(S.current.renderer.domElement); } catch(e) {} S.current.renderer.dispose(); }
    };
  }, []);

  /* ── UPDATE COUCH/PATIENT POS ── */
  useEffect(() => {
    if (!ready) return; const R = S.current.refs;
    const ytop = -C_YOFF + parseF(iso.vert), cz = -parseF(iso.lng);
    R.couchGrp.position.set(parseF(iso.lat), ytop - CT/2, cz); R.couchGrp.rotation.y = 0;
    const pLen = parseF(patient.len), pRx = parseF(patient.rx), pRy = parseF(patient.ry);
    if (patient.show && pLen > 0) {
      R.patGrp.visible = true;
      R.patMesh.scale.set(pRx, pLen, pRy);
      R.patWire.scale.set(pRx*1.01, pLen*1.01, pRy*1.01);
      R.patGrp.position.set(parseF(iso.lat), ytop + pRy, cz + (COUCH_Z_MIN + pLen/2));
      R.patGrp.rotation.y = 0;
    } else R.patGrp.visible = false;
  }, [ready, iso, patient]);

  /* ── REBUILD 3D VIZ ── */
  useEffect(() => {
    if (!ready) return;
    const THREE = window.THREE, R = S.current.refs;
    const clearGrp = g => { while(g.children.length) { const ch=g.children[0]; ch.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();}); g.remove(ch); } };
    clearGrp(R.beamVizGrp); clearGrp(R.ghostGrp);
    R.gantryGrp.rotation.z = 0;

    const ytop = -C_YOFF + parseF(iso.vert), cz = -parseF(iso.lng);
    const items = mode === "static" ? beams : arcs;
    const fS = 15;

    const uniqueAngles = new Map();
    items.forEach((it, i) => { const rm = parseF(it.rm); if (!uniqueAngles.has(rm)) uniqueAngles.set(rm, i); });

    R.couchGrp.visible = uniqueAngles.has(0);
    R.patGrp.visible = patient.show && parseF(patient.len) > 0 && uniqueAngles.has(0);

    uniqueAngles.forEach((firstIdx, rm) => {
      if (rm === 0) return;
      const col = FIELD_COLORS[firstIdx % FIELD_COLORS.length];
      const g = new THREE.Group();

      const gc = new THREE.Mesh(new THREE.BoxGeometry(CW, CT, COUCH_Z_MAX - COUCH_Z_MIN),
        new THREE.MeshStandardMaterial({ color: col.hex, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }));
      gc.position.z = (COUCH_Z_MAX + COUCH_Z_MIN) / 2; g.add(gc);
      const ge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CW, CT, COUCH_Z_MAX - COUCH_Z_MIN)),
        new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: 0.4 }));
      ge.position.z = gc.position.z; g.add(ge);

      if (patient.show && parseF(patient.len) > 0) {
        const pLen = parseF(patient.len), pRx = parseF(patient.rx), pRy = parseF(patient.ry);
        const gp = new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,24),
          new THREE.MeshStandardMaterial({ color: col.hex, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
        gp.rotation.x = Math.PI/2; gp.scale.set(pRx, pLen, pRy);
        gp.position.set(0, pRy + CT/2, COUCH_Z_MIN + pLen/2); g.add(gp);
        const gpw = new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,12),
          new THREE.MeshBasicMaterial({ color: col.hex, wireframe: true, transparent: true, opacity: 0.2 }));
        gpw.rotation.x = Math.PI/2; gpw.scale.set(pRx*1.01, pLen*1.01, pRy*1.01);
        gpw.position.copy(gp.position); g.add(gpw);
      }
      g.position.set(parseF(iso.lat), ytop - CT/2, cz); g.rotation.y = rm * Math.PI / 180;
      R.ghostGrp.add(g);
    });

    if (mode === "static") {
      beams.forEach((b, i) => {
        const baseCol = FIELD_COLORS[i % FIELD_COLORS.length];
        const isAct = activeField === i;
        const res = results[i];
        const st = res ? res.st : "ok";
        const col = st === "col" ? COL_RED : st === "warn" ? COL_WARN : baseCol;
        const rad = parseF(b.g) * Math.PI / 180;
        const lineOp = isAct ? 1.0 : st !== "ok" ? 0.75 : 0.45;
        const fillOp = isAct ? 0.18 : st === "col" ? 0.14 : 0.05;

        R.beamVizGrp.add((() => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,SAD,0), new THREE.Vector3(0,-25,0)]),
          new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: lineOp })); l.rotation.z = rad; return l; })());

        const edges = [[0,SAD,0,fS,0,fS],[0,SAD,0,-fS,0,fS],[0,SAD,0,-fS,0,-fS],[0,SAD,0,fS,0,-fS],
          [fS,0,fS,-fS,0,fS],[-fS,0,fS,-fS,0,-fS],[-fS,0,-fS,fS,0,-fS],[fS,0,-fS,fS,0,fS]];
        const ep = []; edges.forEach(([x1,y1,z1,x2,y2,z2]) => { ep.push(new THREE.Vector3(x1,y1,z1), new THREE.Vector3(x2,y2,z2)); });
        const pyL = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ep),
          new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: lineOp }));
        pyL.rotation.z = rad; R.beamVizGrp.add(pyL);

        [[fS,fS,-fS,fS],[-fS,fS,-fS,-fS],[-fS,-fS,fS,-fS],[fS,-fS,fS,fS]].forEach(([x1,z1,x2,z2]) => {
          const tg = new THREE.BufferGeometry(); tg.setAttribute("position", new THREE.Float32BufferAttribute([0,SAD,0, x1,0,z1, x2,0,z2], 3));
          const m = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: col.hex, transparent: true, opacity: fillOp, side: THREE.DoubleSide, depthWrite: false }));
          m.rotation.z = rad; R.beamVizGrp.add(m);
        });

        const bq = new THREE.BufferGeometry(); bq.setAttribute("position", new THREE.Float32BufferAttribute([-fS,0,-fS, fS,0,-fS, fS,0,fS, -fS,0,-fS, fS,0,fS, -fS,0,fS], 3));
        const bqM = new THREE.Mesh(bq, new THREE.MeshBasicMaterial({ color: col.hex, transparent: true, opacity: isAct ? 0.25 : st==="col" ? 0.2 : 0.08, side: THREE.DoubleSide, depthWrite: false }));
        bqM.rotation.z = rad; R.beamVizGrp.add(bqM);

        const sx = SAD*Math.sin(rad), sy = SAD*Math.cos(rad);
        R.beamVizGrp.add(new THREE.Mesh(new THREE.SphereGeometry(st!=="ok"?4:isAct?3.5:2.5, 12, 12), new THREE.MeshBasicMaterial({ color: col.hex })).translateX(sx).translateY(sy));

        if (st !== "ok") {
          const rg = new THREE.Mesh(new THREE.TorusGeometry(7, 1.2, 8, 32), new THREE.MeshBasicMaterial({ color: col.hex, transparent: true, opacity: 0.55 }));
          rg.position.set(sx, sy, 0); rg.lookAt(0,0,0); R.beamVizGrp.add(rg);
        }
      });

    } else {
      arcs.forEach((a, i) => {
        const baseCol = FIELD_COLORS[i % FIELD_COLORS.length];
        const isAct = activeField === i;
        const res = results[i];
        const st = res ? res.st : "ok";
        const col = st === "col" ? COL_RED : st === "warn" ? COL_WARN : baseCol;
        const steps = 80;
        const start = parseF(a.s), end = parseF(a.e);
        const span = ((end - start) % 360 + 360) % 360 || 360;

        const arcPts = [];
        for (let f = 0; f <= steps; f++) {
          const deg = start + span * (f / steps);
          const rad = deg * Math.PI / 180;
          arcPts.push(new THREE.Vector3(SAD * Math.sin(rad), SAD * Math.cos(rad), 0));
        }

        R.beamVizGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts),
          new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: isAct ? 1.0 : st!=="ok" ? 0.7 : 0.5 })));

        const sV = [], sI = [];
        for (let f = 0; f <= steps; f++) {
          sV.push(arcPts[f].x, arcPts[f].y, 0, 0, 0, 0);
          if (f < steps) sI.push(f*2, f*2+1, (f+1)*2, (f+1)*2, f*2+1, (f+1)*2+1);
        }
        const sGeo = new THREE.BufferGeometry(); sGeo.setAttribute("position", new THREE.Float32BufferAttribute(sV, 3)); sGeo.setIndex(sI);
        R.beamVizGrp.add(new THREE.Mesh(sGeo, new THREE.MeshBasicMaterial({ color: col.hex, transparent: true,
          opacity: isAct ? 0.22 : st==="col" ? 0.18 : 0.07, side: THREE.DoubleSide, depthWrite: false })));

        const spokeN = Math.max(4, Math.round(span / 25));
        for (let f = 0; f <= spokeN; f++) {
          const idx = Math.round(f / spokeN * steps);
          const pp = arcPts[Math.min(idx, steps)];
          R.beamVizGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pp, new THREE.Vector3(0,0,0)]),
            new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: isAct ? 0.3 : 0.1 })));
        }

        [0, steps].forEach(idx => {
          const p = arcPts[idx];
          R.beamVizGrp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, new THREE.Vector3(0,0,0)]),
            new THREE.LineBasicMaterial({ color: col.hex, transparent: true, opacity: isAct ? 0.8 : 0.35 })));
          R.beamVizGrp.add(new THREE.Mesh(new THREE.SphereGeometry(isAct ? 3.5 : 2.5, 10, 10),
            new THREE.MeshBasicMaterial({ color: col.hex })).translateX(p.x).translateY(p.y));
        });

        if (st !== "ok") {
          const mp = arcPts[Math.floor(steps/2)];
          const rg = new THREE.Mesh(new THREE.TorusGeometry(7, 1.2, 8, 32),
            new THREE.MeshBasicMaterial({ color: col.hex, transparent: true, opacity: 0.5 }));
          rg.position.copy(mp); rg.lookAt(0,0,0); R.beamVizGrp.add(rg);
        }
      });
    }
  }, [ready, beams, arcs, mode, activeField, iso, patient, results]);

  /* ── CAMERA ── */
  const onMD = useCallback(e => { dragR.current = { on: true, x: e.clientX, y: e.clientY }; }, []);
  const onMM = useCallback(e => { if (!dragR.current.on) return;
    camR.current.theta -= (e.clientX - dragR.current.x) * 0.006;
    camR.current.phi = Math.max(-0.3, Math.min(1.4, camR.current.phi + (e.clientY - dragR.current.y) * 0.005));
    dragR.current = { on: true, x: e.clientX, y: e.clientY }; }, []);
  const onMU = useCallback(() => { dragR.current.on = false; }, []);
  const onW = useCallback(e => { camR.current.dist = Math.max(120, Math.min(700, camR.current.dist + e.deltaY * 0.4)); }, []);

  /* ── FIELD MANAGEMENT ── */
  const addBeam = () => setBeams([...beams, { id: nextId.current++, g: 0, rm: 0 }]);
  const removeBeam = i => { setBeams(beams.filter((_,idx)=>idx!==i)); if(activeField===i)setActiveField(null); };
  const updateBeam = (i, key, val) => { const n=[...beams]; n[i][key]=val; setBeams(n); };
  const blurBeam = (i, key, val) => { let v = parseF(val); if(key==="rm") v = clamp(v, LIMITS.rm.min, LIMITS.rm.max); const n=[...beams]; n[i][key]=v; setBeams(n); };
  
  const addArc = () => setArcs([...arcs, { id: nextId.current++, s: 181, e: 179, rm: 0 }]);
  const removeArc = i => { setArcs(arcs.filter((_,idx)=>idx!==i)); if(activeField===i)setActiveField(null); };
  const updateArc = (i, key, val) => { const n=[...arcs]; n[i][key]=val; setArcs(n); };
  const blurArc = (i, key, val) => { let v = parseF(val); if(key==="rm") v = clamp(v, LIMITS.rm.min, LIMITS.rm.max); const n=[...arcs]; n[i][key]=v; setArcs(n); };

  const stColor = st => st === "col" ? "#EF4444" : st === "warn" ? "#F59E0B" : "#10B981";
  const stLabel = st => st === "col" ? "COLISÃO" : st === "warn" ? "ATENÇÃO" : "LIVRE";
  const stIcon  = st => st === "col" ? "✕" : st === "warn" ? "⚠" : "✓";
  const sInput = { width:"100%", padding:"7px 8px", background:"#0F172A", border:"1px solid #1E293B", borderRadius:6, color:"#E2E8F0", fontSize:13, fontFamily:"monospace", outline:"none", textAlign:"center" };
  const sLbl = { fontSize:10, color:"#64748B", fontWeight:600, letterSpacing:"0.5px", marginBottom:3, display:"block" };

  return (
    <div style={{ display:"flex", flexDirection: isMobile ? "column" : "row", height:"100vh", background:"#080C14", fontFamily:"'Segoe UI',system-ui,sans-serif", color:"#E2E8F0", overflow:"hidden", position:"relative" }}>
      
      {/* VIEWPORT (Moves to Top on Mobile) */}
      <div ref={mountRef} style={{ height: isMobile ? "45vh" : "100vh", flex: isMobile ? "none" : 1, position:"relative", cursor:"grab" }}
        onPointerDown={onMD} onPointerMove={onMM} onPointerUp={onMU} onPointerLeave={onMU} onWheel={onW}
        onTouchStart={e => onMD({clientX: e.touches[0].clientX, clientY: e.touches[0].clientY})}
        onTouchMove={e => onMM({clientX: e.touches[0].clientX, clientY: e.touches[0].clientY})}
        onTouchEnd={onMU}>
        
        <div style={{ position:"absolute", bottom:14, left:14, fontSize:10, color:"#334155", display:"flex", gap:14, pointerEvents:"none" }}>
          <span>Arrastar: orbitar</span><span>Scroll: zoom</span><span>SAD: {SAD}cm</span></div>

        {activeField!==null && (() => {
          const list = mode==="static"?beams:arcs;
          if (!list[activeField]) return null;
          return <div style={{ position:"absolute", top:14, left:14, padding:"6px 14px", borderRadius:6,
            background:"rgba(13,17,23,0.9)", border:`1px solid ${FIELD_COLORS[activeField%FIELD_COLORS.length].css}40`,
            fontSize:12, fontWeight:700, color:FIELD_COLORS[activeField%FIELD_COLORS.length].css, pointerEvents:"none" }}>
            {mode==="static"?`Campo ${list[activeField].id}`:`Arco ${list[activeField].id}`}</div>;
        })()}

        {(()=>{
          const items = mode==="static"?beams:arcs;
          const angles = new Map(); items.forEach((it,i)=>{const rm=parseF(it.rm);if(!angles.has(rm))angles.set(rm,i);});
          if(angles.size<=1 && angles.has(0)) return null;
          return <div style={{ position:"absolute", top: isMobile ? 50 : 14, right:14, pointerEvents:"none",
            background:"rgba(13,17,23,0.9)", padding:"8px 12px", borderRadius:6, border:"1px solid #1E293B" }}>
            <div style={{ fontSize:9, fontWeight:700, color:"#475569", letterSpacing:"1px", marginBottom:4 }}>POSIÇÕES MESA</div>
            {[...angles.entries()].map(([angle,idx])=>(
              <div key={angle} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
                <div style={{ width:10, height:3, borderRadius:1, background:angle===0?"#475569":FIELD_COLORS[idx%FIELD_COLORS.length].css }}/>
                <span style={{ fontSize:10, color:angle===0?"#94A3B8":FIELD_COLORS[idx%FIELD_COLORS.length].css }}>{angle}°</span>
              </div>))}
          </div>;
        })()}
      </div>

      {/* SIDEBAR (Bottom on Mobile, Right on Desktop) */}
      <div style={{ width: isMobile ? "100%" : 370, minWidth: isMobile ? "100%" : 370, height: isMobile ? "55vh" : "100vh", display:"flex", flexDirection:"column", borderLeft: isMobile ? "none" : "1px solid #1E293B", borderTop: isMobile ? "1px solid #1E293B" : "none", background:"#0D1117" }}>
        
        {/* ── HEADER ASSINADO ── */}
        <div style={{ padding:"14px 18px", borderBottom:"1px solid #1E293B", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink: 0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:32, height:32, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg,#3B82F6,#1D4ED8)", fontSize:16 }}>⚡</div>
            <div>
              <div style={{ fontWeight:700, fontSize:15, color:"#F1F5F9" }}>Collision Guard</div>
              <div style={{ fontSize:9, color:"#475569", fontWeight:600, letterSpacing:"1.2px" }}>TRUEBEAM EDGE</div>
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600 }}>Lucas Cavalcanti</div>
            <div style={{ fontSize: 9, color: "#3B82F6", fontWeight: 700, letterSpacing:"0.5px" }}>radioterapia.ai</div>
          </div>
        </div>

        <div style={{ display:"flex", padding:"10px 14px", gap:6, borderBottom:"1px solid #1E293B", flexShrink: 0 }}>
          {[["static","IMRT / Estático"],["arc","VMAT / Arcos"]].map(([m,lb])=>(
            <button key={m} onClick={()=>{setMode(m);setActiveField(null);}}
              style={{ flex:1, padding:"8px 0", fontSize:11, fontWeight:700, letterSpacing:"0.5px",
                border:mode===m?"1px solid #3B82F6":"1px solid #1E293B", borderRadius:6, cursor:"pointer",
                background:mode===m?"rgba(59,130,246,0.15)":"transparent", color:mode===m?"#60A5FA":"#64748B" }}>{lb}</button>))}
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 14px" }}>

          {/* Global banner */}
          <div style={{ padding:"10px 14px", borderRadius:8, marginBottom:14, textAlign:"center", border:`1px solid ${stColor(worstStatus)}50`, background:`${stColor(worstStatus)}0A` }}>
            <div style={{ fontSize:14, fontWeight:800, color:stColor(worstStatus), marginBottom:2 }}>
              {stIcon(worstStatus)} {worstStatus==="ok"?"PLANO LIVRE":worstStatus==="warn"?"FOLGA REDUZIDA":"COLISÃO DETECTADA"}
            </div>
            <div style={{ fontSize:10, color:"#64748B" }}>
              {results.length} {mode==="static"?"campo":"arco"}{results.length>1?"s":""}
              {" · Folga mín: "}<span style={{ color:stColor(worstStatus), fontWeight:700, fontFamily:"monospace" }}>{Math.min(...results.map(r=>r.dm)).toFixed(1)} cm</span>
            </div>
          </div>

          {/* Isocenter com Sliders Otimizados */}
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10, fontWeight:700, color:"#94A3B8", letterSpacing:"1px", marginBottom:12, display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ color:"#FACC15" }}>◉</span> ISOCENTRO E MESA
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {["lat","vert","lng"].map(k=>(
                <div key={k} style={{ padding: "8px 12px", background: "#0F172A", borderRadius: 8, border: "1px solid #1E293B" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                    <label style={{...sLbl, marginBottom:0}}>{LIMITS[k].label} <span style={{fontSize:9, color:"#475569"}}>cm</span></label>
                    {/* Validação ao perder o foco (permite digitar negativos livremente) */}
                    <input type="number" value={iso[k]} step={0.5} onFocus={e=>e.target.select()}
                      onChange={e => setIso({...iso, [k]: e.target.value})}
                      onBlur={e => {
                        let num = parseF(e.target.value);
                        setIso({...iso, [k]: clamp(num, LIMITS[k].min, LIMITS[k].max)});
                      }}
                      style={{...sInput, width:70, padding:"4px 6px"}}/>
                  </div>
                  {/* Slider nativo restaurado */}
                  <input type="range" min={LIMITS[k].min} max={LIMITS[k].max} step={0.5} value={parseF(iso[k])}
                    onChange={e => setIso({...iso, [k]: parseFloat(e.target.value)})}
                    style={{ width:"100%", cursor:"grab", accentColor: "#3B82F6" }} />
                </div>
              ))}
            </div>
          </div>

          <div style={{ height:1, background:"#1E293B", margin:"16px 0" }}/>

          {/* Patient */}
          <div style={{ marginBottom:14, padding:10, background:"#0F172A", borderRadius:8, border:"1px solid #1E293B" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#94A3B8", letterSpacing:"1px", display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ color:"#22D3EE" }}>⬬</span> PACIENTE</div>
              <button onClick={()=>setPatient({...patient, show:!patient.show})}
                style={{ padding:"2px 10px", fontSize:10, fontWeight:700, border:"1px solid #1E293B", borderRadius:4, cursor:"pointer",
                  background:patient.show?"rgba(34,211,238,0.15)":"transparent", color:patient.show?"#22D3EE":"#475569" }}>{patient.show?"ON":"OFF"}</button>
            </div>
            {patient.show && <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
              {[["rx","RAIO X"],["ry","RAIO Y"],["len","COMPR."]].map(([k,l])=>(
                <div key={k}><label style={sLbl}>{l}</label>
                <input type="number" value={patient[k]} step={1} onFocus={e=>e.target.select()}
                  onChange={e=>setPatient({...patient, [k]: e.target.value})}
                  onBlur={e=>setPatient({...patient, [k]: Math.max(0, parseF(e.target.value))})} style={sInput}/></div>))}
            </div>}
          </div>

          <div style={{ height:1, background:"#1E293B", margin:"4px 0 12px" }}/>

          <div style={{ fontSize:10, fontWeight:700, color:"#94A3B8", letterSpacing:"1px", marginBottom:8 }}>
            {mode==="static"?"CAMPOS DE TRATAMENTO":"ARCOS DE TRATAMENTO"}
            <span style={{ color:"#334155", fontWeight:400, marginLeft:6 }}>Mesa: ±95°</span>
          </div>

          {/* BEAMS */}
          {mode==="static" && beams.map((b,i)=>{
            const col=FIELD_COLORS[i%FIELD_COLORS.length], isAct=activeField===i, res=results[i], st=res?res.st:"ok";
            const brd = st==="col"?"#EF4444":st==="warn"?"#F59E0B":isAct?col.css:"#1E293B";
            return (
              <div key={b.id} onClick={()=>setActiveField(isAct?null:i)} style={{
                padding:10, marginBottom:6, borderRadius:8, cursor:"pointer", transition:"all 0.15s",
                border:`1px solid ${brd}`, background:st==="col"?"#EF444410":st==="warn"?"#F59E0B10":isAct?`${col.css}08`:"#0F172A",
                boxShadow:st==="col"?"0 0 16px rgba(239,68,68,0.15)":st==="warn"?"0 0 10px rgba(245,158,11,0.1)":"none" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:10, height:10, borderRadius:"50%", background:st!=="ok"?stColor(st):col.css, boxShadow:st!=="ok"?`0 0 8px ${stColor(st)}`:isAct?`0 0 6px ${col.css}`:"none" }}/>
                    <span style={{ fontSize:12, fontWeight:700, color:"#CBD5E1" }}>Campo {b.id}</span>
                    <span style={{ fontSize:9, fontWeight:800, padding:"2px 6px", borderRadius:3, background:`${stColor(st)}20`, color:stColor(st) }}>{stLabel(st)}</span>
                  </div>
                  {beams.length>1 && <button onClick={e=>{e.stopPropagation();removeBeam(i);}} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:14, padding:"0 4px" }}>×</button>}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <div><label style={sLbl}>GANTRY (°)</label><input type="number" value={b.g} onClick={e=>e.stopPropagation()} onFocus={e=>e.target.select()} onChange={e=>updateBeam(i,"g",e.target.value)} onBlur={e=>blurBeam(i,"g",e.target.value)} style={sInput}/></div>
                  <div><label style={sLbl}>MESA (°)</label><input type="number" value={b.rm} onClick={e=>e.stopPropagation()} onFocus={e=>e.target.select()} onChange={e=>updateBeam(i,"rm",e.target.value)} onBlur={e=>blurBeam(i,"rm",e.target.value)} style={sInput}/></div>
                </div>
                {res && <div style={{ marginTop:6, fontSize:10, color:"#64748B", display:"flex", gap:8 }}>
                  <span>Folga: <b style={{ color:stColor(st), fontFamily:"monospace" }}>{res.dm.toFixed(1)}cm</b></span>
                  <span>Mesa: <b style={{ fontFamily:"monospace" }}>{res.dc.toFixed(1)}cm</b></span>
                  <span>Pac: <b style={{ fontFamily:"monospace" }}>{res.dp===Infinity?"—":res.dp.toFixed(1)+"cm"}</b></span>
                </div>}
              </div>);
          })}

          {/* ARCS */}
          {mode==="arc" && arcs.map((a,i)=>{
            const col=FIELD_COLORS[i%FIELD_COLORS.length], isAct=activeField===i, res=results[i], st=res?res.st:"ok";
            const brd = st==="col"?"#EF4444":st==="warn"?"#F59E0B":isAct?col.css:"#1E293B";
            return (
              <div key={a.id} onClick={()=>setActiveField(isAct?null:i)} style={{
                padding:10, marginBottom:6, borderRadius:8, cursor:"pointer", transition:"all 0.15s",
                border:`1px solid ${brd}`, background:st==="col"?"#EF444410":st==="warn"?"#F59E0B10":isAct?`${col.css}08`:"#0F172A",
                boxShadow:st==="col"?"0 0 16px rgba(239,68,68,0.15)":st==="warn"?"0 0 10px rgba(245,158,11,0.1)":"none" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:10, height:10, borderRadius:"50%", background:st!=="ok"?stColor(st):col.css, boxShadow:st!=="ok"?`0 0 8px ${stColor(st)}`:isAct?`0 0 6px ${col.css}`:"none" }}/>
                    <span style={{ fontSize:12, fontWeight:700, color:"#CBD5E1" }}>Arco {a.id}</span>
                    <span style={{ fontSize:9, fontWeight:800, padding:"2px 6px", borderRadius:3, background:`${stColor(st)}20`, color:stColor(st) }}>{stLabel(st)}</span>
                  </div>
                  {arcs.length>1 && <button onClick={e=>{e.stopPropagation();removeArc(i);}} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer", fontSize:14, padding:"0 4px" }}>×</button>}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                  {[["s","INÍCIO (°)"],["e","FIM (°)"],["rm","MESA (°)"]].map(([k,l])=>(
                    <div key={k}><label style={sLbl}>{l}</label>
                    <input type="number" value={a[k]} onClick={e=>e.stopPropagation()} onFocus={e=>e.target.select()} onChange={e=>updateArc(i,k,e.target.value)} onBlur={e=>blurArc(i,k,e.target.value)} style={sInput}/></div>))}
                </div>
                {res && <div style={{ marginTop:6, fontSize:10, color:"#64748B", display:"flex", gap:8 }}>
                  <span>Folga: <b style={{ color:stColor(st), fontFamily:"monospace" }}>{res.dm.toFixed(1)}cm</b></span>
                  <span>Mesa: <b style={{ fontFamily:"monospace" }}>{res.dc.toFixed(1)}cm</b></span>
                  <span>Pac: <b style={{ fontFamily:"monospace" }}>{res.dp===Infinity?"—":res.dp.toFixed(1)+"cm"}</b></span>
                </div>}
              </div>);
          })}

          <button onClick={mode==="static"?addBeam:addArc}
            style={{ width:"100%", padding:10, marginBottom:12, fontSize:12, fontWeight:700,
              border:"1px dashed #334155", borderRadius:8, cursor:"pointer", background:"transparent", color:"#64748B" }}>
            + Adicionar {mode==="static"?"Campo":"Arco"}</button>
        </div>
      </div>
    </div>
  );
}