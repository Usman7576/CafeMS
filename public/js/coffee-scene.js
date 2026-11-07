// Real-time 3D coffee scene for the public site and sign-in page. It is decoration only: if WebGL or this
// file is unavailable, the plain illustration stays on screen and everything else still works.
import * as THREE from "../vendor/three.module.min.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildCup() {
  const cup = new THREE.Group();
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xfbf5ec, roughness: 0.32, metalness: 0.02, side: THREE.DoubleSide });

  const profile = [[0, 0], [0.62, 0], [0.74, 0.08], [0.92, 0.55], [1.06, 1.12], [1.1, 1.3], [1.04, 1.3], [0.98, 1.1], [0.84, 0.6], [0.6, 0.16], [0, 0.14]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 72), ceramic);
  cup.add(body);

  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.075, 16, 40, Math.PI * 1.25), ceramic);
  handle.position.set(1.0, 0.72, 0);
  handle.rotation.z = -Math.PI * 0.62;
  cup.add(handle);

  // Coffee surface with simple latte art, drawn once on a canvas
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const paint = canvas.getContext("2d");
  const base = paint.createRadialGradient(size / 2, size / 2, 10, size / 2, size / 2, size / 2);
  base.addColorStop(0, "#8a5a36");
  base.addColorStop(0.7, "#4a2a18");
  base.addColorStop(1, "#2a160c");
  paint.fillStyle = base;
  paint.fillRect(0, 0, size, size);
  paint.strokeStyle = "rgba(244, 222, 190, 0.85)";
  paint.lineCap = "round";
  for (let i = 0; i < 4; i += 1) {
    paint.lineWidth = 11 - i * 2;
    paint.beginPath();
    paint.arc(size / 2, 92 + i * 30, 54 - i * 11, 0.12 * Math.PI, 0.88 * Math.PI);
    paint.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(1.0, 64), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.25 }));
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 1.14;
  cup.add(coffee);

  const saucerProfile = [[0, 0], [1.1, 0], [1.72, 0.2], [1.78, 0.26], [1.7, 0.27], [1.1, 0.1], [0, 0.08]].map(([x, y]) => new THREE.Vector2(x, y));
  const saucer = new THREE.Mesh(new THREE.LatheGeometry(saucerProfile, 72), new THREE.MeshStandardMaterial({ color: 0xc98a52, roughness: 0.42, side: THREE.DoubleSide }));
  saucer.position.y = -0.1;
  cup.add(saucer);
  return cup;
}

function buildBeans(count) {
  const beanShape = new THREE.SphereGeometry(1, 20, 14);
  beanShape.scale(0.16, 0.24, 0.12);
  const beans = new THREE.InstancedMesh(beanShape, new THREE.MeshStandardMaterial({ color: 0x3f2413, roughness: 0.45 }), count);
  const grooveShape = new THREE.TorusGeometry(0.2, 0.012, 6, 24, Math.PI);
  grooveShape.rotateZ(Math.PI / 2);
  grooveShape.scale(0.28, 1, 1);
  grooveShape.translate(0, 0, 0.115);
  const grooves = new THREE.InstancedMesh(grooveShape, new THREE.MeshStandardMaterial({ color: 0x1a0d06, roughness: 0.8 }), count);

  const data = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const radius = 1.95 + (i % 4) * 0.26;
    return {
      angle, radius, height: -0.6 + ((i * 7) % 11) * 0.3, speed: 0.05 + (i % 5) * 0.012, spin: 0.25 + (i % 7) * 0.09, phase: i * 1.7, size: 0.75 + (i % 3) * 0.3
    };
  });
  return { beans, grooves, data };
}

function steamTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const paint = canvas.getContext("2d");
  const glow = paint.createRadialGradient(64, 64, 2, 64, 64, 62);
  glow.addColorStop(0, "rgba(255, 250, 242, 0.55)");
  glow.addColorStop(1, "rgba(255, 250, 242, 0)");
  paint.fillStyle = glow;
  paint.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function startScene(host) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.className = "scene-canvas";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
  camera.position.set(0, 2.7, 8.6);
  camera.lookAt(0, 0.95, 0);

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x6b4a33, 1.5));
  const key = new THREE.DirectionalLight(0xffe6c7, 2.4);
  key.position.set(3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb36b, 0.9);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const cup = buildCup();
  scene.add(cup);
  const { beans, grooves, data } = buildBeans(26);
  scene.add(beans, grooves);

  const steamMap = steamTexture();
  const steam = Array.from({ length: 7 }, (_, i) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: steamMap, transparent: true, depthWrite: false, opacity: 0 }));
    sprite.userData.offset = i / 7;
    scene.add(sprite);
    return sprite;
  });

  const pointer = { x: 0, y: 0 };
  host.closest("section, aside, body").addEventListener("pointermove", (e) => {
    const box = host.getBoundingClientRect();
    pointer.x = ((e.clientX - box.left) / box.width - 0.5) * 2;
    pointer.y = ((e.clientY - box.top) / box.height - 0.5) * 2;
  }, { passive: true });

  const holder = new THREE.Object3D();
  function draw(seconds) {
    cup.rotation.y += ((pointer.x * 0.35 + seconds * 0.12) - cup.rotation.y) * 0.05;
    cup.rotation.x += ((pointer.y * 0.08) - cup.rotation.x) * 0.05;
    cup.position.y = Math.sin(seconds * 0.8) * 0.05;

    data.forEach((b, i) => {
      const a = b.angle + seconds * b.speed;
      holder.position.set(Math.cos(a) * b.radius, b.height + Math.sin(seconds * 0.6 + b.phase) * 0.18, Math.sin(a) * b.radius);
      holder.rotation.set(seconds * b.spin + b.phase, seconds * b.spin * 0.7, b.phase);
      holder.scale.setScalar(b.size);
      holder.updateMatrix();
      beans.setMatrixAt(i, holder.matrix);
      grooves.setMatrixAt(i, holder.matrix);
    });
    beans.instanceMatrix.needsUpdate = true;
    grooves.instanceMatrix.needsUpdate = true;

    steam.forEach((s) => {
      const t = (seconds * 0.16 + s.userData.offset) % 1;
      s.position.set(Math.sin(t * 6 + s.userData.offset * 9) * 0.28, 1.3 + cup.position.y + t * 1.5, Math.cos(t * 5 + s.userData.offset * 7) * 0.22);
      s.scale.setScalar(0.45 + t * 0.8);
      s.material.opacity = Math.sin(t * Math.PI) * 0.6;
    });
    renderer.render(scene, camera);
  }

  function resize() {
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (reduceMotion || !running) draw(2);
  }

  // Runs only while visible, so it never slows the page or drains a battery in the background
  let running = false;
  const clock = new THREE.Clock();
  function loop() {
    if (!running) return;
    draw(clock.getElapsedTime());
    requestAnimationFrame(loop);
  }
  function setRunning(next) {
    if (reduceMotion || next === running) return;
    running = next;
    if (running) loop();
  }
  new ResizeObserver(resize).observe(host);
  new IntersectionObserver((entries) => { host.dataset.visible = String(entries[0].isIntersecting); setRunning(entries[0].isIntersecting && !document.hidden); }).observe(host);
  document.addEventListener("visibilitychange", () => setRunning(!document.hidden && host.dataset.visible === "true"));

  resize();
  draw(2);
  host.classList.add("scene-ready");
}

document.querySelectorAll("[data-coffee-scene]").forEach((host) => {
  try {
    startScene(host);
  } catch (error) {
    console.info("3D scene unavailable; showing the illustration instead.");
  }
});
