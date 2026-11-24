(function () {
'use strict';
if (typeof THREE === 'undefined') { console.error('[earth-cursor] Three.js não carregou.'); return; }

/* ========= CONFIGURAÇÃO (ajuste aqui) ========= */
const CONFIG = {
  // Para produção, baixe a imagem para o seu repositório (ex.: './img/earth.jpg')
  texture:
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_atmos_2048.jpg',
  clockwise: true,          // sentido horário visto de cima do polo norte
  secondsPerRotation: 24,   // tempo de uma volta da Terra
  sizeVsViewport: 0.12,     // tamanho do conjunto (Terra + arcos) em relação à tela
  followSpeed: 3.2,         // quanto maior, mais rápido segue o mouse
  zIndex: 150,
};

const MOON = {
  texture:
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/moon_1024.jpg',
  radius: 1737.4 / 6371, // tamanho real da Lua em relação à Terra (≈ 0,273 do raio da Terra, que vale 1)
  orbitRadius: 2.2,   // distância até a Terra (comprimida: a real seria ~60 raios da Terra, não cabe na tela)
  orbitSec: 14,       // tempo de uma volta da Lua ao redor da Terra
  direction: 1,       // use -1 para inverter o sentido da órbita
  tilt: [72, -15],    // inclinação do plano da órbita [x, z] em graus
};
/* ============================================== */

// Câmera distante com FOV estreito: mesmo enquadramento, mas sem a Lua parecer maior quando passa na frente
const CAM_Z = 40;
const FOV = 9;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const speedFactor = reduceMotion ? 0.3 : 1;
const TAU = Math.PI * 2;
const deg = (d) => (d * Math.PI) / 180;

/* ---------- Renderer / cena ---------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (err) {
  console.error('[earth-cursor] WebGL indisponível:', err);
  return;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
Object.assign(renderer.domElement.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none', // não atrapalha cliques no site
  zIndex: String(CONFIG.zIndex),
});
renderer.domElement.setAttribute('aria-hidden', 'true');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
camera.position.z = CAM_Z;

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(-4, 3, 5);
scene.add(sun);

/* ---------- Grupo principal (segue o mouse) ---------- */
const root = new THREE.Group();
scene.add(root);

/* ---------- Terra ---------- */
const earthTilt = new THREE.Group();
earthTilt.rotation.set(deg(18), 0, deg(-23.4));
root.add(earthTilt);

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1, 64, 64),
  new THREE.MeshStandardMaterial({ color: 0x1a3a6b, roughness: 1, metalness: 0 })
);
earthTilt.add(earth);

new THREE.TextureLoader().load(CONFIG.texture, (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  earth.material.map = tex;
  earth.material.color.set(0xffffff);
  earth.material.needsUpdate = true;
});

/* ---------- Atmosfera ---------- */
const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.14, 64, 64),
    new THREE.ShaderMaterial({
      transparent: true,
      uniforms: { uColor: { value: new THREE.Color(0.26, 0.65, 1.0) } },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: `
        varying vec3 vN;
        void main() {
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec3 vN;
        void main() {
          float i = pow(max(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
          gl_FragColor = vec4(uColor, 1.0) * i * 0.9;
        }`,
    })
);
root.add(atmosphere);

/* ---------- Lua ---------- */
const moonTilt = new THREE.Group();   // inclinação do plano da órbita
moonTilt.rotation.set(deg(MOON.tilt[0]), 0, deg(MOON.tilt[1]));
root.add(moonTilt);

const moonPivot = new THREE.Group();  // gira e leva a Lua ao redor da Terra
moonTilt.add(moonPivot);

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(MOON.radius, 48, 48),
  new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1, metalness: 0 })
);
moon.position.x = MOON.orbitRadius;
moon.rotation.y = Math.PI; // a mesma face fica sempre voltada para a Terra
moonPivot.add(moon);

new THREE.TextureLoader().load(MOON.texture, (tex) => {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  moon.material.map = tex;
  moon.material.color.set(0xffffff);
  moon.material.needsUpdate = true;
});

/* ---------- Cliques na Terra: acelera e, no 5º clique, superGirada + fumaça ---------- */
const SPEED_LEVELS = [1, 2.5, 5, 9, 15];   // multiplicador da rotação após 0..4 cliques
const CLICKS_FOR_SUPER = 5;                // quinto clique = superGirada
const clickState = { clicks: 0, idle: 0, mul: 1, boost: 0, heat: 0, smoke: 0 };
const WHITE = new THREE.Color(1, 1, 1);
const RED_TINT = new THREE.Color(1.0, 0.18, 0.1);
const ATMO_BLUE = new THREE.Color(0.26, 0.65, 1.0);
const ATMO_RED = new THREE.Color(1.0, 0.25, 0.1);

const SMOKE_MAX = 260;
const smokePos = new Float32Array(SMOKE_MAX * 3);
const smokeVel = new Float32Array(SMOKE_MAX * 3);
const smokeSize = new Float32Array(SMOKE_MAX);
const smokeAlpha = new Float32Array(SMOKE_MAX);
const smokeTone = new Float32Array(SMOKE_MAX);
const smokeAge = new Float32Array(SMOKE_MAX).fill(-1); // -1 = partícula livre
const smokeLife = new Float32Array(SMOKE_MAX);
const smokeBase = new Float32Array(SMOKE_MAX);
let smokeNext = 0;
let smokeCarry = 0;

const smokeGeo = new THREE.BufferGeometry();
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3).setUsage(THREE.DynamicDrawUsage));
smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(smokeSize, 1).setUsage(THREE.DynamicDrawUsage));
smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(smokeAlpha, 1).setUsage(THREE.DynamicDrawUsage));
smokeGeo.setAttribute('aTone', new THREE.BufferAttribute(smokeTone, 1));

const smokeMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false,
  uniforms: { uScale: { value: 600 } },
  vertexShader: `
    attribute float aSize;
    attribute float aAlpha;
    attribute float aTone;
    uniform float uScale;
    varying float vAlpha;
    varying float vTone;
    void main() {
      vAlpha = aAlpha;
      vTone = aTone;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying float vAlpha;
    varying float vTone;
    void main() {
      float d = length(gl_PointCoord - 0.5) * 2.0;
      float a = smoothstep(1.0, 0.15, d);
      vec3 col = mix(vec3(0.28, 0.28, 0.30), vec3(0.82, 0.82, 0.84), vTone);
      gl_FragColor = vec4(col, a * vAlpha);
    }`,
});

const smoke = new THREE.Points(smokeGeo, smokeMaterial);
smoke.frustumCulled = false;
smoke.renderOrder = 10;
scene.add(smoke);

function emitSmoke() {
  const R = root.scale.x;
  const u = Math.random() * 2 - 1;
  const th = Math.random() * TAU;
  const s = Math.sqrt(1 - u * u);
  const dx = s * Math.cos(th);
  const dy = u;
  const dz = s * Math.sin(th);
  const i = smokeNext;
  smokeNext = (smokeNext + 1) % SMOKE_MAX;
  const sp = R * (0.35 + Math.random() * 0.7);

  smokePos[i * 3] = root.position.x + dx * R * 1.02;
  smokePos[i * 3 + 1] = root.position.y + dy * R * 1.02;
  smokePos[i * 3 + 2] = root.position.z + dz * R * 1.02;
  smokeVel[i * 3] = dx * sp;
  smokeVel[i * 3 + 1] = dy * sp + R * 0.35; // tende a subir
  smokeVel[i * 3 + 2] = dz * sp * 0.5;
  smokeAge[i] = 0;
  smokeLife[i] = 2.2 + Math.random() * 1.6;
  smokeBase[i] = R * (0.3 + Math.random() * 0.25);
  smokeTone[i] = Math.random();
}

function updateSmoke(dt) {
  if (clickState.smoke > 0) {
    clickState.smoke -= dt;
    smokeCarry += dt * 85;
    while (smokeCarry >= 1) { emitSmoke(); smokeCarry -= 1; }
  }
  const R = root.scale.x;
  const drag = Math.exp(-0.9 * dt);
  for (let i = 0; i < SMOKE_MAX; i++) {
    if (smokeAge[i] < 0) { smokeAlpha[i] = 0; continue; }
    smokeAge[i] += dt;
    const t = smokeAge[i] / smokeLife[i];
    if (t >= 1) { smokeAge[i] = -1; smokeAlpha[i] = 0; continue; }

    smokeVel[i * 3] *= drag;
    smokeVel[i * 3 + 1] = smokeVel[i * 3 + 1] * drag + R * 0.25 * dt;
    smokeVel[i * 3 + 2] *= drag;
    smokePos[i * 3] += smokeVel[i * 3] * dt;
    smokePos[i * 3 + 1] += smokeVel[i * 3 + 1] * dt;
    smokePos[i * 3 + 2] += smokeVel[i * 3 + 2] * dt;

    smokeSize[i] = smokeBase[i] * (1 + 2.6 * t);
    smokeAlpha[i] = 0.5 * Math.min(1, t * 10) * Math.pow(1 - t, 1.4);
  }
  smokeGeo.attributes.position.needsUpdate = true;
  smokeGeo.attributes.aSize.needsUpdate = true;
  smokeGeo.attributes.aAlpha.needsUpdate = true;
}

// Devolve o multiplicador total da velocidade de rotação neste frame
function updateClickEffects(dt) {
  const c = clickState;
  if (c.clicks > 0) {
    c.idle += dt;
    if (c.idle > 4) c.clicks = 0; // sem cliques por 4s: volta ao normal aos poucos
  }
  c.mul += (SPEED_LEVELS[c.clicks] - c.mul) * (1 - Math.exp(-4 * dt));
  c.boost *= Math.exp(-dt / 1.3);

  // a Terra fica avermelhada conforme acelera, bem vermelha na superGirada, e depois esfria até o normal
  const targetHeat = Math.max(c.clicks * 0.08, Math.min(1, c.boost / 50));
  const heatRate = targetHeat > c.heat ? 6 : 1.0; // esquenta rápido, esfria devagar
  c.heat += (targetHeat - c.heat) * (1 - Math.exp(-heatRate * dt));
  if (c.heat < 0.002) c.heat = 0;

  if (earth.material.map) earth.material.color.copy(WHITE).lerp(RED_TINT, c.heat * 0.85);
  earth.material.emissive.setHex(0xff2a05);
  earth.material.emissiveIntensity = c.heat * 0.5;
  atmosphere.material.uniforms.uColor.value.copy(ATMO_BLUE).lerp(ATMO_RED, c.heat);
  if (moon.material.map) moon.material.color.copy(WHITE).lerp(RED_TINT, c.heat * 0.5);

  return c.mul + c.boost;
}

function handleEarthClick(x, y) {
  const v = root.position.clone().project(camera);
  const cx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const cy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const radiusPx = (root.scale.x / (2 * halfH)) * window.innerHeight;
  if (Math.hypot(x - cx, y - cy) > Math.max(radiusPx * 1.35, 28)) return; // clicou fora da Terra

  const c = clickState;
  c.clicks += 1;
  c.idle = 0;
  if (c.clicks >= CLICKS_FOR_SUPER) {
    c.clicks = 0;
    c.boost = reduceMotion ? 8 : 50;      // superGirada
    c.smoke = reduceMotion ? 1.5 : 4;     // segundos emitindo fumaça
  }
}

/* ---------- Seguir o mouse ---------- */
const target = new THREE.Vector3(0, 0, 0);
let halfW = 1;
let halfH = 1;

function setTargetFromPointer(clientX, clientY) {
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = -((clientY / window.innerHeight) * 2 - 1);
  target.set(nx * halfW, ny * halfH, 0);
}
window.addEventListener('pointermove', (e) => setTargetFromPointer(e.clientX, e.clientY), { passive: true });
window.addEventListener(
  'pointerdown',
  (e) => {
    handleEarthClick(e.clientX, e.clientY);
    setTargetFromPointer(e.clientX, e.clientY);
  },
  { passive: true }
);

/* ---------- Resize ---------- */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  halfH = Math.tan(deg(FOV / 2)) * CAM_Z;
  halfW = halfH * camera.aspect;

  // escala do tamanho das partículas de fumaça (em pixels do buffer de desenho)
  smokeMaterial.uniforms.uScale.value =
    renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(deg(FOV / 2)));

  const outerRadius = (MOON.orbitRadius + MOON.radius) * 1.05;
  const visible = Math.min(halfH * 2, halfW * 2);
  root.scale.setScalar((visible * CONFIG.sizeVsViewport) / (outerRadius * 2));
}
window.addEventListener('resize', resize);
resize();

/* ---------- Loop ---------- */
const clock = new THREE.Clock();
const earthRate = ((CONFIG.clockwise ? -1 : 1) * TAU) / CONFIG.secondsPerRotation;
const lean = new THREE.Vector2();

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);

  // posição suave até o mouse
  const k = 1 - Math.exp(-CONFIG.followSpeed * (reduceMotion ? 0.5 : 1) * dt);
  const dx = target.x - root.position.x;
  const dy = target.y - root.position.y;
  root.position.x += dx * k;
  root.position.y += dy * k;

  // inclina levemente na direção do movimento
  const lk = 1 - Math.exp(-6 * dt);
  lean.x += (THREE.MathUtils.clamp(-dy * 0.12, -0.5, 0.5) - lean.x) * lk;
  lean.y += (THREE.MathUtils.clamp(dx * 0.12, -0.5, 0.5) - lean.y) * lk;
  root.rotation.x = lean.x;
  root.rotation.y = lean.y;

  // cliques na Terra aceleram a rotação (5º clique = superGirada + fumaça)
  const boost = updateClickEffects(dt);
  const orbitBoost = 1 + (boost - 1) * 0.3; // a Lua acompanha, mais de leve
  updateSmoke(dt);

  // Terra gira no próprio eixo
  earth.rotation.y += earthRate * speedFactor * boost * dt;

  // Lua orbita a Terra
  moonPivot.rotation.z += ((-MOON.direction * TAU) / MOON.orbitSec) * speedFactor * orbitBoost * dt;

  renderer.render(scene, camera);
});
})();
