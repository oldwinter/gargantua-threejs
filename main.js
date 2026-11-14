import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ================================================================
   工具：整数格点哈希噪声（纹理生成用，比 Math.sin 哈希快得多）
================================================================ */
function makeHasher(seed) {
  const t = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 512; i++) t[i] = (rnd() * 256) | 0;
  return (x, y) => t[(t[x & 255] + y) & 255] / 255;
}

// 二维值噪声，x 方向可按 per 周期环绕（用于贴图无缝拼接）
function makeNoise2(seed) {
  const h = makeHasher(seed);
  return function noise(x, y, per = 0) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const w = a => (per ? ((a % per) + per) % per : a);
    const a = h(w(xi), yi), b = h(w(xi + 1), yi);
    const c = h(w(xi), yi + 1), d = h(w(xi + 1), yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbmFactory(seed) {
  const n = makeNoise2(seed);
  return (x, y, per = 0, oct = 4) => {
    let s = 0, amp = 0.5, f = 1, p = per;
    for (let i = 0; i < oct; i++) {
      s += amp * n(x * f, y * f, p);
      amp *= 0.5; f *= 2; if (p) p *= 2;
    }
    return s / (1 - Math.pow(0.5, oct)) * (1 - Math.pow(0.5, 1)) * 2 - 0;
  };
}

/* ================================================================
   程序化星空贴图（等距柱状投影，供光线弯曲后采样 → 天然带引力透镜）
================================================================ */
const nextFrame = () => new Promise((resolve) => { requestAnimationFrame(() => resolve()); });

async function makeSkyTexture() {
  const W = 2048, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;

  const fbm = fbmFactory(137);
  // 银河带法向（倾斜，避免与吸积盘平面重合显得呆板）
  const bn = (() => {
    const v = [0.42, 0.80, -0.43], l = Math.hypot(...v);
    return v.map(c => c / l);
  })();

  for (let y = 0; y < H; y++) {
    if (y % 64 === 0) await nextFrame();
    const v = (y + 0.5) / H;
    const theta = v * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const phi = (u - 0.5) * 2 * Math.PI;
      const dx = Math.cos(phi) * st, dy = ct, dz = Math.sin(phi) * st;
      const g = dx * bn[0] + dy * bn[1] + dz * bn[2];

      // 近黑基底 + 两层银河辉光 + 尘埃暗带
      let r = 1.5, gg = 2.0, b = 4.0;
      const bandW = Math.exp(-g * g / (2 * 0.40 * 0.40));
      const band = Math.exp(-g * g / (2 * 0.12 * 0.12));
      const n1 = fbm(dx * 4 + 9, dz * 4 + dy * 5, 0, 4);
      const n2 = fbm(dx * 9 - 3, dy * 9 + dz * 7, 0, 3);
      const lane = Math.exp(-Math.pow(g - 0.035, 2) / (2 * 0.045 * 0.045));

      r += bandW * (4 + 10 * n1);
      gg += bandW * (4.5 + 9 * n1);
      b += bandW * (7 + 15 * n1);
      r += band * (46 + 84 * n2) * 0.9;
      gg += band * (33 + 62 * n2) * 0.85;
      b += band * (20 + 38 * n2) * 0.7;
      const dust = lane * (0.35 + 0.6 * n2);
      r *= 1 - dust * 0.62; gg *= 1 - dust * 0.58; b *= 1 - dust * 0.45;

      const i = (y * W + x) * 4;
      px[i] = Math.min(255, r); px[i + 1] = Math.min(255, gg);
      px[i + 2] = Math.min(255, b); px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 恒星：均匀球面撒点 → 投影回等距柱状。跨越左右缝的星画三次防截断。
  let s = 987654321;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const starColors = [
    [255, 255, 255], [255, 255, 255], [255, 246, 232],
    [188, 208, 255], [255, 214, 170], [228, 236, 255],
  ];
  const drawStar = (x, y, rad, col, alpha) => {
    for (const ox of [-W, 0, W]) {
      const gx = x + ox;
      if (gx < -12 || gx > W + 12) continue;
      const grd = ctx.createRadialGradient(gx, y, 0, gx, y, rad);
      grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${alpha})`);
      grd.addColorStop(0.45, `rgba(${col[0]},${col[1]},${col[2]},${alpha * 0.35})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(gx - rad, y - rad, rad * 2, rad * 2);
    }
  };

  for (let i = 0; i < 5200; i++) {
    if (i % 800 === 0) await nextFrame();
    const z = 1 - 2 * rnd(), ph = rnd() * 2 * Math.PI;
    const rr = Math.sqrt(1 - z * z);
    const dx = rr * Math.cos(ph), dy = z, dz = rr * Math.sin(ph);
    const u = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
    const v = Math.acos(Math.max(-1, Math.min(1, dy))) / Math.PI;
    const x = u * W, y = v * H;
    const bright = Math.pow(rnd(), 6.5);          // 少数亮星
    const rad = 0.5 + bright * 1.8 + rnd() * 0.4;
    const col = starColors[(rnd() * starColors.length) | 0];
    drawStar(x, y, rad * 2.2, col, 0.5 + Math.min(0.5, bright * 2.6));
  }
  // 少量很亮的星
  for (let i = 0; i < 60; i++) {
    const z = 1 - 2 * rnd(), ph = rnd() * 2 * Math.PI;
    const rr = Math.sqrt(1 - z * z);
    const u = Math.atan2(rr * Math.sin(ph), rr * Math.cos(ph)) / (2 * Math.PI) + 0.5;
    const v = Math.acos(z) / Math.PI;
    drawStar(u * W, v * H, 6 + rnd() * 6, starColors[(rnd() * 6) | 0], 1.0);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;                       // 与着色器 v=acos(dy)/π 约定一致
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ================================================================
   吸积盘纹理：u=角度(周期)，v=半径。R=剪切湍流条带，G=细颗粒
================================================================ */
function makeDiskTexture() {
  const W = 640, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const fbmA = fbmFactory(41), fbmB = fbmFactory(97);

  for (let y = 0; y < H; y++) {
    const v = y / H;                        // 0 内缘 → 1 外缘
    for (let x = 0; x < W; x++) {
      const u = x / W;
      // 剪切：径向坐标按角度扰动 → 拉出同心弧状条纹
      const shear = fbmA(u * 4, v * 6, 4, 3) * 5.0;
      let n = fbmA(u * 8, v * 30 + shear, 8, 4);
      n = Math.pow(n, 1.4);
      const fine = fbmB(u * 26, v * 110, 26, 3);
      const i = (y * W + x) * 4;
      px[i] = Math.min(255, n * 300);
      px[i + 1] = Math.min(255, fine * 300);
      px[i + 2] = 0; px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/* ================================================================
   渲染器 / 场景
================================================================ */
const canvas = document.getElementById('view');
const bootStatus = document.getElementById('boot-status');
const bootSub = document.getElementById('boot-sub');
if (matchMedia('(max-width: 760px)').matches) {
  bootSub.textContent = '拖动画面可以旋转。点右上角打开参数。';
}
await nextFrame();

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (err) {
  bootStatus.textContent = '这个浏览器没能启动 WebGL';
  bootSub.textContent = '请换用桌面版 Chrome、Edge 或 Firefox 后再打开。';
  document.querySelector('#boot .boot-spin')?.remove();
  throw err;
}
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// 视角相机（仅提供轨道参数，不直接参与绘制）
const viewCam = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
const CAM_HOME = new THREE.Vector3(0, 3.6, 14.2);
viewCam.position.copy(CAM_HOME);

// 全屏四边形 + 光线步进材质
const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

bootStatus.textContent = '正在生成星空';
const skyTex = await makeSkyTexture();
bootStatus.textContent = '正在生成吸积盘';
await nextFrame();
const diskTex = makeDiskTexture();

const uniforms = {
  uCamPos:    { value: new THREE.Vector3() },
  uCamBasis:  { value: new THREE.Matrix3() },
  uTanFov:    { value: Math.tan(THREE.MathUtils.degToRad(viewCam.fov / 2)) },
  uAspect:    { value: innerWidth / innerHeight },
  uRs:        { value: 1.0 },
  uDiskIn:    { value: 3.2 },
  uDiskOut:   { value: 9.0 },
  uSteps:     { value: 256 },
  uDoppler:   { value: 0.85 },
  uDiskBright:{ value: 1.5 },
  uTempShift: { value: 0.12 },
  uDiskAlpha: { value: 0.55 },
  uExposure:  { value: 1.0 },
  uSkyBright: { value: 1.0 },
  uTime:      { value: 0 },
  uSpin:      { value: 1.0 },
  uSky:       { value: skyTex },
  uDisk:      { value: diskTex },
};

const frag = /* glsl */`
varying vec2 vUv;
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform float uTanFov;
uniform float uAspect;
uniform float uRs;
uniform float uDiskIn;
uniform float uDiskOut;
uniform int uSteps;
uniform float uDoppler;
uniform float uDiskBright;
uniform float uTempShift;
uniform float uDiskAlpha;
uniform float uExposure;
uniform float uSkyBright;
uniform float uTime;
uniform float uSpin;
uniform sampler2D uSky;
uniform sampler2D uDisk;

const float PI = 3.141592653589793;

vec2 equirectUV(vec3 d){
  return vec2(atan(d.z, d.x)/(2.0*PI)+0.5,
              acos(clamp(d.y,-1.0,1.0))/PI);
}

// 吸积盘黑体式色带（内白 → 金 → 橙 → 暗红），uTempShift 偏移色温
vec3 diskColor(float t){
  float tt = clamp(t - uTempShift*0.28, 0.0, 1.0);
  vec3 c0 = vec3(1.32, 1.20, 0.98);
  vec3 c1 = vec3(1.18, 0.80, 0.40);
  vec3 c2 = vec3(0.88, 0.42, 0.14);
  vec3 c3 = vec3(0.40, 0.14, 0.05);
  vec3 c = tt < 0.16 ? mix(c0, c1, tt/0.16)
       : tt < 0.55 ? mix(c1, c2, (tt-0.16)/0.39)
                   : mix(c2, c3, (tt-0.55)/0.45);
  return c;
}

void main(){
  vec2 ndc = vUv*2.0 - 1.0;
  vec3 v = normalize(uCamBasis * vec3(ndc.x*uTanFov*uAspect, ndc.y*uTanFov, 1.0));
  vec3 p = uCamPos;
  float rs = uRs;

  // 守恒角动量 h² = |p×v|² （|v|=1 时即碰撞参数 b 的平方）
  vec3 hv = cross(p, v);
  float h2 = dot(hv, hv);

  float camR = length(uCamPos);
  float escapeR = max(camR*2.1, uDiskOut*3.0);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  float endR = 1e9;
  int hits = 0;
  vec3 prevP = p;

  // 史瓦西时空零测地线：p'' = -(3/2)·rs·h²·p/r⁵
  for (int i = 0; i < 384; i++){
    if (i >= uSteps) break;
    float r2 = dot(p, p);
    float r = sqrt(r2);
    if (r < rs){ captured = true; break; }

    vec3 acc = -1.5*rs*h2*p/(r2*r2*r);
    float dt = clamp(r*0.045, 0.012, 0.5);

    prevP = p;
    v = normalize(v + acc*dt);
    p += v*dt;

    // 穿越吸积盘平面 y=0：插值求交点并累积辐射
    if (p.y*prevP.y < 0.0 && trans > 0.02 && hits < 3){
      float t = prevP.y/(prevP.y - p.y);
      vec3 hp = mix(prevP, p, t);
      float rr = length(hp);
      if (rr > uDiskIn && rr < uDiskOut){
        hits++;
        // 高阶鬼影衰减：首次交叉(正视盘/包裹像)保持亮度，后续递减
        float hitW = hits == 1 ? 1.0 : hits == 2 ? 0.6 : 0.35;
        float rt = (rr - uDiskIn)/(uDiskOut - uDiskIn);

        // 角坐标 + 差速自转（内快外慢，开普勒式）
        float ang = atan(hp.z, hp.x);
        float rot = uTime*uSpin*1.4*pow(uDiskIn/rr, 1.5);
        vec2 duv = vec2((ang+rot)*0.15915494, rt);
        float streak = texture2D(uDisk, duv).r*0.78
                     + texture2D(uDisk, vec2(duv.x*2.9+0.37, rt)).g*0.45 + 0.12;
        streak = pow(streak, 1.7)*1.6;

        // 径向亮度：内缘陡亮 + 热环
        float prof = pow(max(1.0-rt, 0.0), 3.8);
        prof *= smoothstep(0.0, 0.05, rt);
        prof += exp(-rt*22.0)*0.7;

        // 引力红移（内缘变暗变红）
        float gred = sqrt(clamp(1.0 - rs/rr, 0.0, 1.0))/0.82;

        // 多普勒增亮：朝观察者运动的一侧更亮偏蓝
        vec3 velDir = normalize(vec3(hp.z, 0.0, -hp.x)); // 俯视顺时针 → 左侧增亮（电影构图）
        vec3 outDir = -normalize(v);
        float beta = uDoppler * 1.35 * clamp(sqrt(rs/(2.0*max(rr-rs, 0.15))), 0.0, 0.98);
        float dn = clamp(1.0 - dot(velDir, outDir)*beta, 0.06, 2.0);
        float beam = clamp(0.55/(dn*dn*dn), 0.05, 6.0);
        float dsh = dot(velDir, outDir);

        vec3 dc = diskColor(rt);
        dc = mix(dc, dc*vec3(0.85,0.92,1.35), clamp(dsh*uDoppler, 0.0, 1.0)*0.5);
        dc = mix(dc, dc*vec3(1.30,0.72,0.45), clamp(-dsh*uDoppler, 0.0, 1.0)*0.5);

        // 相机极近盘面时淡出，避免镜头没入气体时全屏发白
        float cdist = length(hp - uCamPos);
        float nearFade = smoothstep(0.4, 3.0, cdist);

        float I = prof*streak*beam*gred*uDiskBright*hitW*nearFade;
        col += dc*I*trans;
        trans *= 1.0 - clamp(uDiskAlpha*(0.45 + 1.2*I), 0.0, 0.97);
      }
    }

    if (r > escapeR && dot(p, v) > 0.0){ endR = r; break; }
    endR = r;
  }

  // 步数耗尽仍困在光子球附近的轨迹视作被捕获
  if (!captured && endR < rs*2.0) captured = true;

  vec3 sky = captured ? vec3(0.0)
             : texture2D(uSky, equirectUV(normalize(v))).rgb;
  col += sky*uSkyBright*trans;
  col *= uExposure;
  gl_FragColor = vec4(col, 1.0);
}`;

const vert = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const quadMat = new THREE.ShaderMaterial({
  uniforms, vertexShader: vert, fragmentShader: frag,
  depthTest: false, depthWrite: false,
});
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

/* ---------- 后期：HDR Bloom ---------- */
const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(quadScene, quadCam));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.55, 0.35, 1.1);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

/* ---------- 轨道控制 ---------- */
const controls = new OrbitControls(viewCam, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 5.5;
controls.maxDistance = 42;
controls.enablePan = false;
controls.autoRotateSpeed = 0.9;

/* ================================================================
   参数面板
================================================================ */
const params = {
  mass: 1.0, diskIn: 3.2, diskOut: 9.0, diskBright: 1.35,
  tempShift: 0.12, doppler: 0.85, diskAlpha: 0.7, spin: 1.0,
  exposure: 0.95, skyBright: 1.1, bloom: 0.55, bloomRadius: 0.35,
  steps: 256, resScale: 0.8, fov: 50,
};

const GROUPS = [
  { title: '黑 洞', items: [
    { key: 'mass',       label: '质量 (Rs)',      min: 0.5,  max: 2.0,  step: 0.01, fmt: 2 },
  ]},
  { title: '吸 积 盘', items: [
    { key: 'diskIn',     label: '内半径',          min: 1.6,  max: 6.0,  step: 0.05, fmt: 2 },
    { key: 'diskOut',    label: '外半径',          min: 5.0,  max: 16.0, step: 0.1,  fmt: 1 },
    { key: 'diskBright', label: '亮度',            min: 0.0,  max: 3.0,  step: 0.01, fmt: 2 },
    { key: 'tempShift',  label: '色温 (冷↔暖)',    min: -1.0, max: 1.0,  step: 0.01, fmt: 2 },
    { key: 'doppler',    label: '多普勒增亮',      min: 0.0,  max: 1.2,  step: 0.01, fmt: 2 },
    { key: 'diskAlpha',  label: '不透明度',        min: 0.0,  max: 1.0,  step: 0.01, fmt: 2 },
    { key: 'spin',       label: '旋转速度',        min: 0.0,  max: 3.0,  step: 0.01, fmt: 2 },
  ]},
  { title: '画 面', items: [
    { key: 'exposure',   label: '曝光',            min: 0.2,  max: 2.5,  step: 0.01, fmt: 2 },
    { key: 'skyBright',  label: '星空亮度',        min: 0.0,  max: 2.0,  step: 0.01, fmt: 2 },
    { key: 'bloom',      label: '辉光强度',        min: 0.0,  max: 2.0,  step: 0.01, fmt: 2 },
    { key: 'bloomRadius',label: '辉光半径',        min: 0.0,  max: 1.0,  step: 0.01, fmt: 2 },
  ]},
  { title: '渲 染', items: [
    { key: 'steps',      label: '光线步进数',      min: 64,   max: 384,  step: 8,    fmt: 0 },
    { key: 'resScale',   label: '渲染分辨率',      min: 0.4,  max: 1.0,  step: 0.05, fmt: 2 },
    { key: 'fov',        label: '视场角',          min: 25,   max: 90,   step: 1,    fmt: 0 },
  ]},
];

const PRESETS = [
  { name: '卡冈图雅', p: { mass:1.0, diskIn:3.2, diskOut:9.0, diskBright:1.35, tempShift:0.12, doppler:0.85, diskAlpha:0.7, spin:1.0, exposure:0.95, skyBright:1.1, bloom:0.55, bloomRadius:0.35 } },
  { name: '炽热狂暴', p: { diskIn:2.6, diskOut:10.5, diskBright:2.4, tempShift:-0.35, doppler:0.95, diskAlpha:0.65, spin:1.7, exposure:1.05, bloom:1.0, bloomRadius:0.5 } },
  { name: '暗红垂死', p: { diskIn:3.8, diskOut:12.0, diskBright:0.85, tempShift:0.7, doppler:0.9, diskAlpha:0.6, spin:0.65, exposure:0.9, bloom:0.55, skyBright:1.1 } },
  { name: '引力透镜', p: { diskBright:0.0, diskAlpha:0.0, skyBright:1.7, bloom:0.5, exposure:1.0, mass:1.0 } },
];

function applyParam(key) {
  const v = params[key];
  switch (key) {
    case 'mass':       uniforms.uRs.value = v; break;
    case 'diskIn':
    case 'diskOut': {
      const gap = 0.4;
      if (params.diskIn > params.diskOut - gap) {
        if (key === 'diskIn') params.diskOut = Math.min(16, Math.round((params.diskIn + gap) * 10) / 10);
        else params.diskIn = Math.max(1.6, Math.round((params.diskOut - gap) * 20) / 20);
      }
      uniforms.uDiskIn.value = params.diskIn;
      uniforms.uDiskOut.value = params.diskOut;
      ctlRefs.diskIn?.();
      ctlRefs.diskOut?.();
      break;
    }
    case 'diskBright': uniforms.uDiskBright.value = v; break;
    case 'tempShift':  uniforms.uTempShift.value = v; break;
    case 'doppler':    uniforms.uDoppler.value = v; break;
    case 'diskAlpha':  uniforms.uDiskAlpha.value = v; break;
    case 'spin':       uniforms.uSpin.value = v; break;
    case 'exposure':   uniforms.uExposure.value = v; break;
    case 'skyBright':  uniforms.uSkyBright.value = v; break;
    case 'bloom':      bloomPass.strength = v; break;
    case 'bloomRadius':bloomPass.radius = v; break;
    case 'steps':      uniforms.uSteps.value = v | 0; break;
    case 'resScale':   resize(); break;
    case 'fov':
      viewCam.fov = v;
      viewCam.updateProjectionMatrix();
      uniforms.uTanFov.value = Math.tan(THREE.MathUtils.degToRad(v / 2));
      break;
  }
}

function applyAll() { for (const k in params) applyParam(k); }

/* ---------- 生成 UI ---------- */
const groupsEl = document.getElementById('groups');
const ctlRefs = {};
for (const g of GROUPS) {
  const div = document.createElement('div');
  div.className = 'group';
  div.innerHTML = `<div class="group-title">${g.title}</div>`;
  if (g.items.some((it) => it.key === 'resScale')) {
    div.id = 'render-group';
    div.insertAdjacentHTML('beforeend', '<p class="group-note">如果卡顿，先降渲染分辨率，再降光线步进数。</p>');
  }
  for (const it of g.items) {
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    ctl.innerHTML = `
      <div class="row"><span>${it.label}</span><span class="val"></span></div>
      <input type="range" min="${it.min}" max="${it.max}" step="${it.step}">`;
    const input = ctl.querySelector('input');
    const val = ctl.querySelector('.val');
    input.setAttribute('aria-label', it.label);
    const refresh = () => { input.value = params[it.key]; val.textContent = (+params[it.key]).toFixed(it.fmt); };
    input.addEventListener('input', () => { params[it.key] = +input.value; applyParam(it.key); refresh(); markDirty(); });
    refresh();
    ctlRefs[it.key] = refresh;
    div.appendChild(ctl);
  }
  groupsEl.appendChild(div);
}

/* ---------- 预设 ---------- */
const presetsEl = document.getElementById('presets');
const presetBtns = [];
for (const pr of PRESETS) {
  const b = document.createElement('button');
  b.textContent = pr.name;
  b.addEventListener('click', () => {
    Object.assign(params, pr.p);
    applyAll();
    for (const k in ctlRefs) ctlRefs[k]();
    presetBtns.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
  presetsEl.appendChild(b);
  presetBtns.push(b);
}
function markDirty() { presetBtns.forEach(x => x.classList.remove('active')); }
presetBtns[0].classList.add('active');

/* ---------- 面板开关 / 视角 ---------- */
const panel = document.getElementById('panel');
const toggle = document.getElementById('paneltoggle');
function setPanel(hidden) {
  panel.classList.toggle('hidden', hidden);
  toggle.classList.toggle('shifted', hidden);
  document.body.classList.toggle('panel-closed', hidden);
  const narrow = matchMedia('(max-width: 760px)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  toggle.textContent = narrow ? (hidden ? '参数' : '关闭') : '⟨';
  toggle.setAttribute('aria-expanded', String(!hidden));
  toggle.setAttribute('aria-label', hidden ? '展开参数' : '收起参数');
  const hintText = document.getElementById('hint-text');
  if (narrow && coarse) hintText.textContent = '拖动旋转 · 双指缩放';
  else if (narrow) hintText.textContent = '拖拽旋转 · 滚轮缩放';
  else hintText.textContent = hidden
    ? '拖拽旋转 · 滚轮缩放 · H 显示面板'
    : '拖拽旋转 · 滚轮缩放 · H 隐藏面板';
  resize();
}
toggle.addEventListener('click', () => setPanel(!panel.classList.contains('hidden')));
addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.key === 'h' || e.key === 'H') setPanel(!panel.classList.contains('hidden'));
});
setPanel(matchMedia('(max-width: 760px)').matches);
let narrowNow = matchMedia('(max-width: 760px)').matches;
matchMedia('(max-width: 760px)').addEventListener('change', (e) => {
  narrowNow = e.matches;
  setPanel(e.matches);
});
document.getElementById('resetview').addEventListener('click', () => {
  viewCam.position.copy(CAM_HOME);
  controls.target.set(0, 0, 0);
});
const autoRot = document.getElementById('autorotate');
autoRot.addEventListener('change', () => { controls.autoRotate = autoRot.checked; });

/* ================================================================
   尺寸 / 主循环
================================================================ */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const s = params.resScale;
  const w = Math.max(2, Math.floor(rect.width * s));
  const h = Math.max(2, Math.floor(rect.height * s));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);
  const aspect = rect.width / Math.max(1, rect.height);
  uniforms.uAspect.value = aspect;
  viewCam.aspect = aspect;
  viewCam.updateProjectionMatrix();
}
addEventListener('resize', () => {
  const next = matchMedia('(max-width: 760px)').matches;
  if (next !== narrowNow) {
    narrowNow = next;
    setPanel(next);
  } else {
    resize();
  }
});

const basis = new THREE.Matrix3();
const fpsEl = document.getElementById('fps');
const perfBtn = document.getElementById('perf');
const clock = new THREE.Clock();
let frames = 0, fpsTime = 0, lowStreak = 0, highStreak = 0, shown = false;

perfBtn.addEventListener('click', () => {
  setPanel(false);
  const scroller = document.getElementById('groups');
  const group = document.getElementById('render-group');
  scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  group.classList.add('pulse');
  setTimeout(() => group.classList.remove('pulse'), 1800);
});

bootStatus.textContent = '正在编译光线';
await nextFrame();
applyAll();
resize();
clock.getDelta();

// 便于调试/脚本控制视角
window.__demo = { viewCam, controls, params, uniforms };

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  uniforms.uTime.value += dt;

  controls.update();
  viewCam.updateMatrixWorld();
  const e = viewCam.matrixWorld.elements;
  // matrixWorld 各列：right / up / -fwd
  basis.set(
    e[0], e[4], -e[8],
    e[1], e[5], -e[9],
    e[2], e[6], -e[10],
  );
  uniforms.uCamBasis.value.copy(basis);
  uniforms.uCamPos.value.copy(viewCam.position);

  composer.render();
  if (!shown) {
    shown = true;
    const boot = document.getElementById('boot');
    boot.classList.add('done');
    const hideBoot = () => { boot.hidden = true; };
    boot.addEventListener('transitionend', hideBoot, { once: true });
    setTimeout(hideBoot, 700);
  }

  frames++; fpsTime += dt;
  if (fpsTime > 0.5) {
    const fps = Math.round(frames / fpsTime);
    fpsEl.textContent = `${fps} FPS · ${(params.resScale * 100) | 0}% · ${params.steps | 0} 步`;
    if (fps < 20) { lowStreak++; highStreak = 0; }
    else if (fps >= 24) { highStreak++; lowStreak = 0; }
    if (lowStreak >= 2) perfBtn.hidden = false;
    if (highStreak >= 2) perfBtn.hidden = true;
    frames = 0; fpsTime = 0;
  }
}
tick();
