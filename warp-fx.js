/*! warp-fx.js — WebGL slider effects for Webflow (Edge warp).
 *
 * One engine, plug-in effects. Each effect has its own settings & presets;
 * several effects run as a chain in the order given.
 *
 *   const fx = WarpFX(sliderEl, {
 *     effects: ["edge-warp"],
 *     settings: { "edge-warp": { amount: 6 } },
 *     live:     { "edge-warp": { amount: "--ew-amount" } },  // follow CSS variables
 *   });
 *   fx.set("edge-warp", { radius: 40 });
 */
(function () {
  /* ---------------------------------------------------------------- shaders */
  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vUv.y = 1.0 - vUv.y;               // 0 = top, same as Figma / canvas
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // Shared by every effect. uFlip: textures rendered by a previous pass are
  // stored upside-down relative to the uploaded scene, so we flip on read.
  const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform int uFlip;
vec4 tex(vec2 uv) { return textureLod(uTex, uFlip == 1 ? vec2(uv.x, 1.0 - uv.y) : uv, 0.0); }
// Outside the frame: left/right count as empty (cut-off cards), but above
// and below there is only background, so reuse the edge row (the texture
// clamps). This removes the coloured seam where tilt reaches past the frame.
vec4 sampleZ(vec2 uv) {
  float insideX = step(0.0, uv.x) * step(uv.x, 1.0);
  return tex(uv) * insideX;
}
vec3 straightRgb(vec4 c) { return c.rgb / max(c.a, 0.00001); }
`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, f) => (Number.isFinite(+v) ? +v : f);

  /* ---------------------------------------------------------------- effects */
  const EFFECTS = {
    "edge-warp": {
      label: "Edge warp",
      prefix: "ew",   // Webflow attributes: data-ew-amount, data-ew-preset, …
      defaults: {
        edgeMode: 1, lensStyle: 0, halfOrientation: 0, posX: 50, posY: 50,
        radius: 54.5, rectangleAspect: 1.37,
        scale: 0.42, separateXY: true, scaleX: 1.87, scaleY: 1,
        amount: 2.6, dispersion: 0.35, splitAngle: 19, glow: 0, edgeWidth: 49.3, falloff: 4,
        mirrorLens: false, hideBackground: false,
        tiltLeft: -3, tiltRight: 3,   // vertical bend per side (+ down, − up)
        tiltSwap: false,             // swap left/right (e.g. for RTL sites)
        motionBoost: 5,   // extra warp + split while the slider moves
      },
      presets: {
        "edge-warp": {},  // = defaults
        // Inside-ramp bulge look.
        "inside": {
          edgeMode: 2, radius: 33, scale: 2.46, separateXY: true, scaleX: 1.6, scaleY: 1,
          amount: 16, dispersion: 0.3, splitAngle: 0, glow: 0, edgeWidth: 35.1, falloff: 1.55, motionBoost: 2.6,
        },
      },
      words: {
        edgeMode: { band: 0, outside: 1, inside: 2 },
        lensStyle: { disc: 0, rectangle: 1, "half-disc": 2, "half-rectangle": 3 },
        halfOrientation: { top: 0, bottom: 1, left: 2, right: 3 },
      },
      frag: COMMON + `uniform vec2 uPos, uScale;
uniform int uStyle, uHalf, uEdgeMode, uMirror, uHide;
uniform float uRadius, uAmount, uDisp, uGlow, uEdge, uFalloff, uSplit, uAspect;
uniform float uTiltL, uTiltR;   // vertical bend per side, % of short side (+ = down)

float lensDistance(vec2 p, float r, float ratio, int style, int orientation) {
  if (style == 0) return length(p) - r;
  vec2 halfSize = vec2(r * ratio, r);
  vec2 halfP = vec2(p.x, -p.y);
  float cutExtent = halfSize.x;
  if (orientation == 1) halfP = p;
  if (orientation == 2) { halfP = vec2(p.y, -p.x); cutExtent = halfSize.y; }
  if (orientation == 3) { halfP = vec2(p.y, p.x); cutExtent = halfSize.y; }
  if (style == 2) {
    float cutDistance = length(vec2(max(abs(halfP.x) - r, 0.0), halfP.y));
    float arcDistance = abs(length(halfP) - r);
    if (halfP.y < 0.0) arcDistance = length(vec2(abs(halfP.x) - r, halfP.y));
    float bd = min(cutDistance, arcDistance);
    return (halfP.y >= 0.0 && length(halfP) <= r) ? -bd : bd;
  }
  float corner = min(halfSize.x, halfSize.y) * 0.035;
  vec2 q = abs(p) - halfSize + vec2(corner);
  float rectD = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - corner;
  if (style == 3) {
    if (halfP.y < 0.0) return length(vec2(max(abs(halfP.x) - cutExtent, 0.0), halfP.y));
    return max(rectD, -halfP.y);
  }
  return rectD;
}

void main() {
  vec2 dims = max(uSize, vec2(1.0));
  vec2 uv = vUv;
  float radius = max(uRadius, 0.0);
  float dispersion = max(uDisp, 0.0);
  float glow = max(uGlow, 0.0);
  bool mirrorLens = uMirror == 1;
  vec4 inputColor = tex(uv);
  // Unit = 0.5625 × width: the cards scale with the slider width, so the
  // effect does too. On a 16:9 screen this equals the old "short side",
  // so existing settings keep their look; other screen shapes now match it.
  float shortSide = dims.x * 0.5625;
  vec2 centerPx = uPos * 0.01 * dims;
  vec2 p = uv * dims - centerPx;
  float r = max(radius * 0.01 * shortSide, 1.0);
  vec2 axisScale = max(uScale, vec2(0.01));
  // Frame taller than 16:9 (phones, where one big card fills the height):
  // make the lens as tall as the frame, so only the left/right sides warp
  // and the tops of the cards stay straight.
  if (dims.y > dims.x * 0.5625 * 1.02) axisScale.y = max(axisScale.y, dims.y * 0.6 / max(radius * 0.01 * shortSide, 1.0));
  vec2 lensP = p / axisScale;
  float localSd = lensDistance(lensP, r, uAspect, uStyle, uHalf);
  vec2 gradient = vec2(
    lensDistance(lensP + vec2(0.5, 0.0), r, uAspect, uStyle, uHalf) - lensDistance(lensP - vec2(0.5, 0.0), r, uAspect, uStyle, uHalf),
    lensDistance(lensP + vec2(0.0, 0.5), r, uAspect, uStyle, uHalf) - lensDistance(lensP - vec2(0.0, 0.5), r, uAspect, uStyle, uHalf)
  ) / axisScale;
  float sd = localSd / max(length(gradient), 1.0 / max(axisScale.x, axisScale.y));
  if (abs(axisScale.x - axisScale.y) < 0.00001) sd = localSd * axisScale.x;
  vec2 normal = gradient / max(length(gradient), 0.0001);
  float widthPx = max(uEdge * 0.01 * shortSide, 1.0);
  float band = pow(1.0 - smoothstep(0.0, widthPx, abs(sd)), max(uFalloff, 0.25));
  float insideLens = 1.0 - smoothstep(-0.75, 0.75, sd);
  float shape = band, weight = band, rimMask = band;
  if (uEdgeMode == 1) {
    float t = clamp(max(sd, 0.0) / widthPx, 0.0, 6.0);
    shape = pow(t, max(uFalloff, 0.25));
    weight = 1.0;
    rimMask = min(shape, 1.0);
  }
  float theta = uSplit * 0.01745329252;
  vec2 splitNormal = vec2(normal.x * cos(theta) - normal.y * sin(theta), normal.x * sin(theta) + normal.y * cos(theta));
  vec2 basePx = uv * dims;
  if (mirrorLens) basePx = mix(basePx, centerPx + vec2(-p.x, p.y), insideLens);
  vec2 bentPx = basePx - normal * uAmount * 0.01 * shortSide * shape;
  vec2 spreadPx = splitNormal * dispersion * 0.01 * shortSide * shape;
  if (uEdgeMode == 2) {
    float inner = pow(clamp(-sd / widthPx, 0.0, 1.0), max(uFalloff, 0.25));
    float rEff = max(r * max(axisScale.x, axisScale.y), 1.0);
    vec2 radial = p / rEff;
    vec2 radialSplit = vec2(radial.x * cos(theta) - radial.y * sin(theta), radial.x * sin(theta) + radial.y * cos(theta));
    bentPx = basePx - p * uAmount * 0.01 * inner;
    spreadPx = radialSplit * dispersion * 0.01 * shortSide * inner;
    shape = inner;
    weight = 1.0;
  }
  // Left/right tilt: blend the two side values across the lens so there is
  // no seam, then shift vertically by the same ramp that drives the warp.
  float sideT = smoothstep(-1.0, 1.0, p.x / max(r * axisScale.x, 1.0));
  bentPx.y -= mix(uTiltL, uTiltR, sideT) * 0.01 * shortSide * shape;
  vec4 rs = sampleZ((bentPx + spreadPx) / dims);
  vec4 gs = sampleZ(bentPx / dims);
  vec4 bs = sampleZ((bentPx - spreadPx) / dims);
  float lensAlpha = (rs.a + gs.a + bs.a) / 3.0;
  vec3 lensRgb = vec3(straightRgb(rs).r, straightRgb(gs).g, straightRgb(bs).b);
  vec4 refracted = vec4(lensRgb * lensAlpha, lensAlpha);
  vec4 baseColor = inputColor;
  if (mirrorLens) baseColor = mix(inputColor, sampleZ(basePx / dims), insideLens);
  vec4 composite = mix(baseColor, refracted, weight);
  float rim = exp(-pow(sd / max(widthPx * 0.23, 1.0), 2.0)) * band;
  if (uEdgeMode == 1) rim = rimMask * 0.5;
  if (uEdgeMode == 2) rim = exp(-pow(sd / max(widthPx * 0.23, 1.0), 2.0)) * insideLens;
  vec3 glowRgb = composite.rgb + vec3(0.86, 0.93, 1.0) * glow * rim * composite.a;
  vec4 highlighted = vec4(min(glowRgb, vec3(composite.a)), composite.a);
  outColor = uHide == 1 ? highlighted * insideLens : highlighted;
}`,
      apply(U, S, w, h, boost) {
        let sx = clamp(num(S.scale, 1), 0.1, 5), sy = sx;
        if (S.separateXY) { sx *= clamp(num(S.scaleX, 1), 0.1, 5); sy *= clamp(num(S.scaleY, 1), 0.1, 5); }
        U.f2("uPos", num(S.posX, 50), num(S.posY, 50)); U.f2("uScale", sx, sy);
        U.i("uStyle", clamp(Math.round(num(S.lensStyle, 0)), 0, 3)); U.i("uHalf", clamp(Math.round(num(S.halfOrientation, 0)), 0, 3));
        U.i("uEdgeMode", clamp(Math.round(num(S.edgeMode, 0)), 0, 2));
        U.i("uMirror", S.mirrorLens ? 1 : 0); U.i("uHide", S.hideBackground ? 1 : 0);
        U.f("uRadius", Math.max(0, num(S.radius, 25))); U.f("uAspect", clamp(num(S.rectangleAspect, 1.65), 0.25, 4));
        U.f("uAmount", num(S.amount, 0) * (1 + boost * 0.6)); U.f("uDisp", Math.max(0, num(S.dispersion, 0)) * (1 + boost * 2));
        U.f("uGlow", Math.max(0, num(S.glow, 0))); U.f("uEdge", clamp(num(S.edgeWidth, 4.5), 0.1, 100));
        U.f("uFalloff", clamp(num(S.falloff, 1.4), 0.25, 4)); U.f("uSplit", num(S.splitAngle, 0));
        let tl = num(S.tiltLeft, 0), tr = num(S.tiltRight, 0);
        if (S.tiltSwap) [tl, tr] = [tr, tl];
        U.f("uTiltL", tl * (1 + boost * 0.6)); U.f("uTiltR", tr * (1 + boost * 0.6));
      },
    },

  };

  // Engine-level slide motion (applies under every effect).
  const MOTION_DEFAULTS = {
    zoomOut: 1,       // % smaller at the middle of a slide (0 = off)
    zoomSpeed: 3,     // how fast it zooms out while you drag
    fluid: 0.6,       // fluid trail: drawn slides glide after the real position (0 = off, 1 ≈ 300 ms)
  };

  /* ---------------------------------------------------------------- helpers */
  function detectBackground(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c)) return c;
    }
    return null;
  }

  /* ---------------------------------------------------------------- engine */
  function WarpFX(slider, opts = {}) {
    const names = Object.keys(EFFECTS);
    const settings = {};
    for (const n of names) {
      const E = EFFECTS[n];
      const presetName = (opts.presets || {})[n];
      settings[n] = { ...E.defaults, ...(E.presets[presetName] || {}), ...((opts.settings || {})[n] || {}) };
    }
    let chain = (opts.effects || ["edge-warp"]).filter((n) => EFFECTS[n]);
    // Slide zoom: one ease-in-out "out and back in" that happens DURING the
    // slide and lands at 100% exactly when the slide lands. Nothing after.
    const motion = { ...MOTION_DEFAULTS, ...(opts.motion || {}) };
    const live = opts.live || {};

    const container = opts.container || slider.parentElement;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "2" });
    container.appendChild(canvas);

    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    const scene = document.createElement("canvas");
    const sctx = scene.getContext("2d");
    const imgSel = opts.imageSelector || "img";
    const bg = opts.background !== undefined ? opts.background : detectBackground(container);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let visible = true, io = null;   // off-screen → the render loop stops completely
    const progs = {};
    // zoomZ: 0 = normal size, 1 = fully zoomed out.
    let zoomZ = 0, lastT = 0, lastMoveT = -1e9;
    let lag = 0, lastF = 0, lastLefts = new Map();   // fluid trail (CSS px the drawing lags behind the slider)
    let hooked = null, dragging = false, tr = null;   // tr = running transition {t0, dur, z0}
    const ease = (p) => p * p * (3 - 2 * p);                     // smooth in-out
    const bell = (p) => 0.5 - 0.5 * Math.cos(2 * Math.PI * p);   // 0 → 1 → 0, smooth ends
    // Swiper tells us exactly when a slide transition starts and how long it
    // runs, so the zoom can finish at the same moment the slide lands.
    function hookSwiper() {
      const sw = slider.swiper;
      if (!sw || sw === hooked) return;
      hooked = sw;
      sw.on("touchStart", () => { tr = null; });
      sw.on("sliderMove", () => { dragging = true; tr = null; });
      sw.on("touchEnd", () => { dragging = false; });
      sw.on("setTransition", (_s, d) => {
        if (d > 0) tr = { t0: performance.now(), dur: d, z0: zoomZ };
      });
      sw.on("transitionEnd", () => { tr = null; zoomZ = 0; dirty = true; });
    }
    let sceneTex, fbos = [], fbSize = '', quad, enabled = false, dirty = true, raf = 0, lastX = null, velocity = 0, trackEl = null;

    function sh(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    function makeTex() {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      return t;
    }
    function init() {
      const vs = sh(gl.VERTEX_SHADER, VERT);
      for (const n of names) {   // compile every effect once, so toggling is instant
        const p = gl.createProgram();
        gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, EFFECTS[n].frag));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(n + ": " + gl.getProgramInfoLog(p));
        const loc = {};
        const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) { const a = gl.getActiveUniform(p, i); loc[a.name] = gl.getUniformLocation(p, a.name); }
        const U = {
          i: (k, v) => loc[k] && gl.uniform1i(loc[k], v),
          f: (k, v) => loc[k] && gl.uniform1f(loc[k], v),
          f2: (k, a, b) => loc[k] && gl.uniform2f(loc[k], a, b),
        };
        progs[n] = { p, U, aPos: gl.getAttribLocation(p, "aPos") };
      }
      quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      sceneTex = makeTex();
      for (let k = 0; k < 2; k++) {   // ping-pong targets for chained effects
        const t = makeTex(), fb = gl.createFramebuffer();
        fbos.push({ t, fb });
      }
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // The effect gets its own frame: full width, at most 16:9 tall, centered
      // on the slider. Every screen then sees the frame the settings were
      // tuned in, and tall phones don't get warp smeared into empty space.
      const r = container.getBoundingClientRect(), sr = slider.getBoundingClientRect();
      // At most 16:9 of the width, but always tall enough for the cards
      // (phones: one big card is taller than a 16:9 strip).
      const bandH = Math.max(1, Math.min(r.height, Math.max(r.width * 0.5625, sr.height * 1.15)));
      const top = Math.max(0, Math.min(r.height - bandH, sr.top + sr.height / 2 - r.top - bandH / 2));
      canvas.style.top = top + "px"; canvas.style.bottom = "auto"; canvas.style.height = bandH + "px";
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(bandH * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = scene.width = w; canvas.height = scene.height = h; }
      if (gl && fbos.length && fbSize !== w + 'x' + h) {
        fbSize = w + 'x' + h;
        for (const { t, fb } of fbos) {
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
      }
      dirty = true;
    }

    // Draw an <img> the way CSS shows it (object-fit / object-position).
    // Rounded cards: copy the corner radius of the nearest rounded parent
    // (e.g. a card with border-radius + overflow hidden) so the drawn copy matches.
    // Card titles (opts.textSelector) are drawn into the picture too, so the
    // side cards show them and they bend with the warp.
    const textSel = opts.textSelector || "";
    const textCache = new WeakMap();
    function drawTexts(img, base, dpr, zs, zcx, zcy) {
      const slide = img.closest("[data-fx-slide]"); if (!slide) return;
      for (const el of slide.querySelectorAll(textSel)) {
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        let c = textCache.get(el);
        if (!c) {
          const cs = getComputedStyle(el);
          let txt = (el.textContent || "").trim().replace(/\s+/g, " ");
          if (cs.textTransform === "uppercase") txt = txt.toUpperCase();
          else if (cs.textTransform === "lowercase") txt = txt.toLowerCase();
          const size = parseFloat(cs.fontSize) || 16;
          c = { txt, size, color: cs.color, align: cs.textAlign, ls: parseFloat(cs.letterSpacing) || 0,
                lh: parseFloat(cs.lineHeight) || size * 1.2, font: [cs.fontStyle, cs.fontWeight].join(" "), fam: cs.fontFamily };
          textCache.set(el, c);
        }
        if (!c.txt) continue;
        const k = dpr * zs;
        const X = zcx + ((r.left - base.left - lag) * dpr - zcx) * zs, Y = zcy + ((r.top - base.top) * dpr - zcy) * zs, W = r.width * k;
        sctx.save();
        sctx.font = c.font + " " + c.size * k + "px " + c.fam;
        sctx.fillStyle = c.color; sctx.textBaseline = "middle";
        if ("letterSpacing" in sctx) sctx.letterSpacing = c.ls * k + "px";
        const al = c.align === "center" ? "center" : (c.align === "right" || c.align === "end") ? "right" : "left";
        sctx.textAlign = al;
        const lines = []; let line = "";
        for (const w of c.txt.split(" ")) {
          const t = line ? line + " " + w : w;
          if (line && sctx.measureText(t).width > W + 1) { lines.push(line); line = w; } else line = t;
        }
        lines.push(line);
        const x = al === "center" ? X + W / 2 : al === "right" ? X + W : X;
        lines.forEach((ln, i) => sctx.fillText(ln, x, Y + (i + 0.5) * c.lh * k));
        sctx.restore();
      }
    }
    // Overlays (opts.overlaySelector), e.g. the card's dark gradient: their CSS
    // linear-gradient background is redrawn on the side cards too.
    const overlaySel = opts.overlaySelector || "";
    const gradCache = new WeakMap();
    function splitTop(str) {   // split on commas that are not inside ( )
      const out = []; let depth = 0, cur = "";
      for (const ch of str) {
        if (ch === "(") depth++; else if (ch === ")") depth--;
        if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    function parseGradient(el) {
      if (gradCache.has(el)) return gradCache.get(el);
      const cs = getComputedStyle(el), bg = cs.backgroundImage;
      let g = null;
      const m = bg && bg.match(/^linear-gradient\((.*)\)$/);
      if (m) {
        const parts = splitTop(m[1]);
        let angle = 180;                                   // CSS default: to bottom
        const first = parts[0];
        if (/deg$/.test(first)) { angle = parseFloat(first); parts.shift(); }
        else if (/^to /.test(first)) {
          const map = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 };
          angle = map[first] !== undefined ? map[first] : 180; parts.shift();
        }
        const stops = parts.map((p) => {
          const mm = p.match(/^(.*\))\s*([\d.]+%)?$/) || p.match(/^(\S+)\s*([\d.]+%)?$/);
          return mm ? { color: mm[1], pos: mm[2] ? parseFloat(mm[2]) / 100 : null } : null;
        }).filter(Boolean);
        stops.forEach((st, i) => { if (st.pos === null) st.pos = stops.length > 1 ? i / (stops.length - 1) : 0; });
        if (stops.length) g = { angle, stops, opacity: parseFloat(cs.opacity) || 1 };
      }
      gradCache.set(el, g);
      return g;
    }
    function drawOverlays(img, base, dpr, zs, zcx, zcy) {
      const slide = img.closest("[data-fx-slide]"); if (!slide) return;
      for (const el of slide.querySelectorAll(overlaySel)) {
        const g = parseGradient(el); if (!g) continue;
        const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const k = dpr * zs;
        const X = zcx + ((r.left - base.left - lag) * dpr - zcx) * zs, Y = zcy + ((r.top - base.top) * dpr - zcy) * zs;
        const W = r.width * k, H = r.height * k;
        const a = g.angle * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
        const L = Math.abs(W * dx) + Math.abs(H * dy), cx = X + W / 2, cy = Y + H / 2;
        const lg = sctx.createLinearGradient(cx - dx * L / 2, cy - dy * L / 2, cx + dx * L / 2, cy + dy * L / 2);
        for (const st of g.stops) { try { lg.addColorStop(Math.min(1, Math.max(0, st.pos)), st.color); } catch (e) {} }
        sctx.save(); sctx.globalAlpha = g.opacity; sctx.fillStyle = lg; sctx.fillRect(X, Y, W, H); sctx.restore();
      }
    }
    const radii = new WeakMap();
    function radiusOf(img) {
      if (radii.has(img)) return radii.get(img);
      let r = 0;
      for (let n = img; n && n !== slider; n = n.parentElement) {
        const v = parseFloat(getComputedStyle(n).borderTopLeftRadius) || 0;
        if (v > 0) { r = v; break; }
      }
      radii.set(img, r);
      return r;
    }
    function drawFitted(img, dx, dy, dw, dh) {
      const cs = getComputedStyle(img);
      const fit = cs.objectFit, nw = img.naturalWidth, nh = img.naturalHeight;
      const pos = cs.objectPosition.split(" ").map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : 0.5));
      const ox = pos[0] ?? 0.5, oy = pos[1] ?? 0.5;
      if (fit === "cover") {
        // Draw the whole image (no source crop) and clip it to the box.
        // Source-rect cropping breaks with responsive images (srcset): their
        // naturalWidth is density-corrected, not the real pixel size, so a crop
        // in those units grabs only the top-left part of the picture.
        const s = Math.max(dw / nw, dh / nh), w = nw * s, h = nh * s;
        sctx.save(); sctx.beginPath(); sctx.rect(dx, dy, dw, dh); sctx.clip();
        sctx.drawImage(img, dx + (dw - w) * ox, dy + (dh - h) * oy, w, h);
        sctx.restore();
      } else if (fit === "contain" || fit === "scale-down") {
        const s = Math.min(dw / nw, dh / nh, fit === "scale-down" ? 1 : Infinity), w = nw * s, h = nh * s;
        sctx.drawImage(img, dx + (dw - w) * ox, dy + (dh - h) * oy, w, h);
      } else {
        sctx.drawImage(img, dx, dy, dw, dh);
      }
    }

    function readLive() {
      let cs = null;
      for (const n of chain) {
        const map = live[n]; if (!map) continue;
        cs = cs || getComputedStyle(slider);
        for (const k in map) {
          const raw = cs.getPropertyValue(map[k]).trim();
          if (raw === "") continue;
          const v = parseFloat(raw);
          const val = Number.isNaN(v) ? raw === "true" : v;
          if (settings[n][k] !== val) { settings[n][k] = val; dirty = true; }
        }
      }
    }

    function frame() {
      if (!visible) { raf = 0; return; }   // off-screen: stop until it scrolls back
      raf = requestAnimationFrame(frame);
      if (!enabled) return;
      readLive();
      const imgs = slider.querySelectorAll(imgSel);
      // Velocity from how far one image moved. Loop sliders re-order slides,
      // so a changed element or an impossible jump counts as a teleport.
      // Movement this frame = the median of every image's movement. A loop
      // slider moves a few slides from one end to the other; the median
      // ignores those, so motion stays continuous through every loop jump.
      const moves = [], seen = new Map();
      for (const im of imgs) {
        const l = im.getBoundingClientRect().left;
        seen.set(im, l);
        const prev = lastLefts.get(im);
        if (prev !== undefined) moves.push(l - prev);
      }
      lastLefts = seen;
      moves.sort((a, b) => a - b);
      let dxs = moves.length ? moves[moves.length >> 1] : 0;   // signed
      let dv = Math.abs(dxs);
      // Fluid: the drawn slides trail the real slider and glide in after it
      // (exponential smoothing, frame-rate independent).
      const nowF = performance.now();
      const dtF = Math.min(Math.max((nowF - (lastF || nowF)) / 1000, 0), 0.1); lastF = nowF;
      // Once the slider has landed (no drag, no transition) the trail catches
      // up 3x faster, so the picture stops right when the slider stops.
      const landed = hooked && !dragging && !tr;
      const tau = reduceMotion ? 0 : Math.max(0, num(motion.fluid, 0)) * 0.3 * (landed ? 0.33 : 1);
      lag = tau > 0 ? (lag + dxs) * Math.exp(-dtF / tau) : 0;
      if (Math.abs(lag) < 0.05) lag = 0;
      velocity += (Math.min(dv / 40, 1) - velocity) * (1 - Math.exp(-dtF * 7.7));   // = 0.12 per frame at 60fps, same feel at any fps

      // Slide zoom
      hookSwiper();
      const now = performance.now();
      const dt = Math.min(Math.max((now - (lastT || now)) / 1000, 1 / 240), 1 / 30); lastT = now;
      if (dv > 0.5) lastMoveT = now;
      const zoomOn = !reduceMotion && num(motion.zoomOut, 0) > 0;
      const k = 1 - Math.exp(-dt * 10 * Math.max(0.1, num(motion.zoomSpeed, 1)));
      let zoomActive = false;
      if (!zoomOn) {
        zoomZ = 0;
      } else if (hooked && tr) {
        // Release snap or arrow click: from the current zoom, go (further) out
        // and come back in, reaching 100% exactly at the end of the transition.
        const p = clamp((now - tr.t0) / tr.dur, 0, 1);
        zoomZ = tr.z0 * (1 - ease(p)) + (1 - tr.z0) * bell(p);
        zoomActive = p < 1;
        if (!zoomActive) { tr = null; zoomZ = 0; }
      } else if (hooked && dragging) {
        zoomZ += (1 - zoomZ) * k;            // finger down: ease out
        zoomActive = true;
      } else if (!hooked) {
        // Any other slider: zoom follows the motion and is back at 100% the
        // moment it stops moving.
        const target = now - lastMoveT < 60 ? 1 : 0;
        zoomZ += (target - zoomZ) * (target ? k : Math.min(1, k * 1.6));
        zoomActive = zoomZ > 0.001;
        if (!zoomActive) zoomZ = 0;
      } else {
        zoomZ = 0;
      }
      const moving = velocity > 0.002 || dv > 0.1 || zoomActive || lag !== 0;
      if (!moving && !dirty) return;   // idle: nothing to redraw
      dirty = moving;

      // 1) Draw the slide images where the slider currently has them.
      const base = canvas.getBoundingClientRect();   // the effect frame
      const dpr = canvas.width / Math.max(base.width, 1);
      const zs = 1 - (num(motion.zoomOut, 0) / 100) * zoomZ;   // e.g. 0.92 mid-slide, 1 when landed
      const zcx = scene.width / 2, zcy = scene.height / 2;
      sctx.clearRect(0, 0, scene.width, scene.height);
      if (bg) { sctx.fillStyle = bg; sctx.fillRect(0, 0, scene.width, scene.height); }
      for (const img of imgs) {
        if (!img.complete || !img.naturalWidth) { dirty = true; continue; }
        const r = img.getBoundingClientRect();
        if (r.right - lag < base.left - 50 || r.left - lag > base.right + 50) continue;
        const dx = (r.left - base.left - lag) * dpr, dy = (r.top - base.top) * dpr;
        const X = zcx + (dx - zcx) * zs, Y = zcy + (dy - zcy) * zs, W = r.width * dpr * zs, H = r.height * dpr * zs;
        const rad = radiusOf(img) * dpr * zs;
        if (rad > 0 && sctx.roundRect) { sctx.save(); sctx.beginPath(); sctx.roundRect(X, Y, W, H, Math.min(rad, W / 2, H / 2)); sctx.clip(); }
        try { drawFitted(img, X, Y, W, H); }
        catch (e) { console.warn("WarpFX: image blocked (CORS?)", img.src); }
        if (overlaySel) drawOverlays(img, base, dpr, zs, zcx, zcy);   // gradient first,
        if (textSel) drawTexts(img, base, dpr, zs, zcx, zcy);          // title stays bright on top
        if (rad > 0 && sctx.roundRect) sctx.restore();
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene); }
      catch (e) { console.warn("WarpFX: canvas tainted by a cross-origin image — enable CORS", e); api.setEnabled(false); return; }

      // 2) Run the effect chain: scene → effect 1 → effect 2 → … → screen.
      let input = sceneTex, flip = 0;
      const boost = reduceMotion ? 0 : velocity;
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      chain.forEach((n, idx) => {
        const last = idx === chain.length - 1;
        const target = last ? null : fbos[idx % 2];
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const P = progs[n];
        gl.useProgram(P.p);
        gl.enableVertexAttribArray(P.aPos);
        gl.vertexAttribPointer(P.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, input);
        P.U.i("uTex", 0); P.U.f2("uSize", canvas.width, canvas.height); P.U.i("uFlip", flip);
        const S = settings[n];
        EFFECTS[n].apply(P.U, S, canvas.width, canvas.height, boost * num(S.motionBoost, 0));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (target) { input = target.t; flip = 1; }
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    const ro = new ResizeObserver(resize);
    const onLoad = () => (dirty = true);

    const api = {
      ok: false,
      settings,
      motion,
      setMotion(obj) { Object.assign(motion, obj); dirty = true; },
      get effects() { return chain.slice(); },
      set(effect, obj) { if (settings[effect]) { Object.assign(settings[effect], obj); dirty = true; } },
      preset(effect, name) {
        const E = EFFECTS[effect]; if (!E) return;
        Object.assign(settings[effect], E.defaults, E.presets[name] || {}); dirty = true;
      },
      setEffects(list) {
        chain = list.filter((n) => EFFECTS[n]);
        api.setEnabled(chain.length > 0 && api.ok);
      },
      redraw() { dirty = true; },
      // True when nothing is moving: no drag trail, no velocity, no zoom.
      isIdle() { return !enabled || (Math.abs(lag) < 0.75 && zoomZ < 0.02); },
      setEnabled(on) {
        enabled = !!on && api.ok && chain.length > 0;
        slider.classList.toggle("warp-active", enabled);   // CSS hides the real images
        canvas.style.display = enabled ? "block" : "none";
        dirty = true;
      },
      destroy() {
        cancelAnimationFrame(raf); ro.disconnect(); if (io) io.disconnect();
        slider.removeEventListener("load", onLoad, true);
        slider.classList.remove("warp-active"); canvas.remove();
      },
    };

    try {
      if (!gl) throw new Error("WebGL2 not available");
      init();
      api.ok = true;
      ro.observe(container); ro.observe(slider);
      slider.addEventListener("load", onLoad, true);
      resize();
      api.setEnabled(true);
      raf = requestAnimationFrame(frame);
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver((en) => {
          visible = en[0].isIntersecting;
          if (visible && !raf) { dirty = true; lastLefts = new Map(); raf = requestAnimationFrame(frame); }
        }, { rootMargin: "50px" });
        io.observe(container);
      }
    } catch (e) {
      console.warn("WarpFX disabled, showing the plain slider:", e);
      api.setEnabled(false);
    }
    return api;
  }

  WarpFX.EFFECTS = EFFECTS;
  WarpFX.MOTION_DEFAULTS = MOTION_DEFAULTS;
  window.WarpFX = WarpFX;
})();

/* =========================================================================
   Webflow auto-setup — everything from attributes, no extra code.

   On the slider (.swiper):
     data-warp-fx="edge-warp"              which effect(s), comma-separated, in order
     data-fx-slides="5" (desktop) / data-fx-slides-tablet="3" / data-fx-slides-mobile="3"
     data-fx-gap="2%" (or px) / data-fx-loop / data-fx-speed="900" (ms)
     data-fx-ease="cubic-bezier(0.22, 1, 0.36, 1)" (slide landing curve)
     data-fx-zoom-out="0" (%, 0 = off) / data-fx-zoom-speed="3" / data-fx-fluid="0.5" (0 = off)
     data-fx-momentum="true" (glide after release) / data-fx-click-center="true" (click a card to center it)
   Edge warp settings:    data-ew-preset, data-ew-amount, data-ew-edge-mode="outside", …
   Any value can be a Webflow variable:  data-ew-amount="var(--ew-amount)"
   In the section (data-fx-section): data-fx-prev, data-fx-next, data-fx-current, data-fx-total
   ========================================================================= */
(function () {
  /* ---------------------------------------------------------------- styles */
  const style = document.createElement("style");
  style.textContent = [
    // Image sliders: hide the real images, the effect draws them.
    "[data-warp-fx].warp-active:not([data-fx-cards]) img{opacity:0!important}",
    "[data-warp-fx] [data-fx-slide]:not(.swiper-slide-active){cursor:pointer}",
    // Card sliders: the effect draws every card from its cover; the real
    // center card shows on top only while nothing moves (it isn't warped).
    "[data-fx-cards].warp-active [data-fx-slide]>*{opacity:0}",
    "[data-fx-cards].warp-active.fx-settled [data-fx-slide].swiper-slide-active>*{opacity:1}",
  ].join("");
  document.head.appendChild(style);

  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const pad = (n) => String(n).padStart(2, "0");
  const numAttr = (el, name, d) => { const v = parseFloat(el.getAttribute(name)); return Number.isNaN(v) ? d : v; };
  const SWIPER_SRC = "https://cdn.jsdelivr.net/npm/swiper@11.1.14/swiper-bundle.min.js";

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error("WarpFX: could not load " + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function readEffect(el, name) {
    const E = WarpFX.EFFECTS[name], pre = "data-" + E.prefix + "-";
    const keys = Object.keys(E.defaults), words = E.words || {};
    const settings = {}, live = {};
    for (const a of el.attributes) {
      if (!a.name.startsWith(pre)) continue;
      const key = camel(a.name.slice(pre.length));
      if (!keys.includes(key)) continue;
      const raw = a.value.trim(), v = raw.toLowerCase();
      const m = raw.match(/^var\(\s*(--[^)\s]+)\s*\)$/);
      if (m) { live[key] = m[1]; continue; }
      if (words[key] && v in words[key]) { settings[key] = words[key][v]; continue; }
      if (v === "true" || v === "on") { settings[key] = true; continue; }
      if (v === "false" || v === "off") { settings[key] = false; continue; }
      const n = parseFloat(v);
      if (!Number.isNaN(n)) settings[key] = n;
    }
    return { settings, live, preset: el.getAttribute(pre + "preset") || Object.keys(E.presets)[0] };
  }

  // Swiper class names can be your own (data-fx-wrapper-class / data-fx-slide-class).
  const wrapperClassOf = (el) => el.getAttribute("data-fx-wrapper-class") || "swiper-wrapper";
  const slideClassOf = (el) => el.getAttribute("data-fx-slide-class") || "swiper-slide";

  /* ---------------------------------------------------------------- slider */
  function setupSwiper(el, scope) {
    if (el.getAttribute("data-fx-swiper") === "false" || el.swiper) return el.swiper || null;
    if (!window.Swiper) { console.warn("WarpFX: Swiper not loaded"); return null; }
    const wrapperClass = wrapperClassOf(el), slideClass = slideClassOf(el);
    const wrapper = el.querySelector("." + wrapperClass);
    if (!wrapper) { console.warn("WarpFX: no ." + wrapperClass + " inside", el); return null; }
    // Minimal Swiper CSS for custom class names (no Swiper stylesheet needed).
    el.style.overflow = "hidden"; el.style.touchAction = "pan-y";
    wrapper.style.display = "flex"; wrapper.style.transitionProperty = "transform"; wrapper.style.boxSizing = "content-box";
    // Cards in view per device (includes the cut-off side cards).
    const perView = numAttr(el, "data-fx-slides", 5);               // desktop ≥ 992px
    const perTablet = numAttr(el, "data-fx-slides-tablet", 3);      // 768–991px
    const perMobile = numAttr(el, "data-fx-slides-mobile", 3);      // < 768px
    // Gap between cards: "2%" of the slider width (scales with the cards) or a px number.
    const gapRaw = (el.getAttribute("data-fx-gap") || "2%").trim();
    const gap = gapRaw.endsWith("%") ? gapRaw : (parseFloat(gapRaw) || 0);
    const loop = el.getAttribute("data-fx-loop") !== "false";
    const originals = [...wrapper.children];
    const realCount = Math.max(originals.length, 1);
    // Centred loops need plenty of slides: add copies (hidden from screen
    // readers) until there are 5x the slides in view.
    if (loop && originals.length) {
      while (wrapper.children.length < Math.max(perView, perTablet, perMobile) * 5) {
        for (const s of originals) { const c = s.cloneNode(true); c.setAttribute("aria-hidden", "true"); wrapper.appendChild(c); }
      }
    }
    for (const s of wrapper.children) { s.setAttribute("data-fx-slide", ""); s.style.flexShrink = "0"; }
    const cur = scope.querySelector("[data-fx-current]"), tot = scope.querySelector("[data-fx-total]");
    const prev = scope.querySelector("[data-fx-prev]"), next = scope.querySelector("[data-fx-next]");
    if (tot) tot.textContent = pad(realCount);
    let spv = Math.ceil(Math.max(perView, perTablet, perMobile)); if (spv % 2 === 0) spv += 1;   // Swiper rounds up to odd when centered
    // Landing: strong ease-out, so every slide glides softly into place.
    wrapper.style.transitionTimingFunction = el.getAttribute("data-fx-ease") || "cubic-bezier(0.22, 1, 0.36, 1)";
    const sw = new Swiper(el, swiperExtras({
      wrapperClass, slideClass,
      // Loop buffer: as many cards as possible on BOTH sides of the visible ones, so a hard flick never runs out of cards.
      loopAdditionalSlides: Math.max(0, Math.floor((wrapper.children.length - spv) / 2) - 2),
      slidesPerView: perMobile, spaceBetween: gap, centeredSlides: true,
      loop, speed: numAttr(el, "data-fx-speed", 550), grabCursor: true, resistanceRatio: 0.6,
      breakpoints: { 768: { slidesPerView: perTablet }, 992: { slidesPerView: perView } },
      // Momentum: after release it keeps gliding, then settles on the nearest card.
      freeMode: el.getAttribute("data-fx-momentum") === "false" ? false
        : { enabled: true, momentum: true, momentumRatio: 0.6, momentumVelocityRatio: 0.7, momentumBounce: false, sticky: true },
      slideToClickedSlide: el.getAttribute("data-fx-click-center") !== "false",
      on: { slideChange(s) { if (cur) cur.textContent = pad((s.realIndex % realCount) + 1); } },
    }, el, scope));
    if (cur) cur.textContent = pad((sw.realIndex % realCount) + 1);
    return sw;
  }
  function swiperExtras(params, el, scope) {
    // Taps on the play / sound icons must never start a drag.
    const noSwipe = el.getAttribute("data-fx-no-swipe") ||
      (el.hasAttribute("data-fx-cards") ? ".play-wrapper,.stop-wrapper,.audio-mute,.audio-unmute" : "");
    if (noSwipe) { params.noSwiping = true; params.noSwipingSelector = noSwipe; }
    const prev = scope.querySelector("[data-fx-prev]"), next = scope.querySelector("[data-fx-next]");
    if (prev || next) params.navigation = { prevEl: prev, nextEl: next };
    return params;
  }

  /* ------------------------------------------------- settled / moving state
     "settled" = no drag, no slide animation and the effect is at rest.
     Toggles .fx-settled on the slider and fires fx:settled / fx:moving. */
  function trackSettled(el, sw, inst) {
    let settled = false, dragging = false, ticking = false;
    const set = (v) => {
      if (v === settled) return;
      settled = v;
      el.classList.toggle("fx-settled", v);
      el.dispatchEvent(new CustomEvent(v ? "fx:settled" : "fx:moving"));
    };
    const tick = () => {
      if (!dragging && !sw.animating && (!inst || !inst.ok || inst.isIdle())) { ticking = false; set(true); return; }
      requestAnimationFrame(tick);
    };
    const watch = () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } };
    const moving = () => { set(false); watch(); };   // synchronous: lids close before the next frame
    sw.on("sliderMove", () => { dragging = true; moving(); });
    sw.on("touchEnd", () => { dragging = false; watch(); });
    sw.on("transitionStart", moving);
    sw.on("slideChangeTransitionStart", moving);
    sw.on("transitionEnd", watch);
    watch();
    return { get settled() { return settled; }, get dragging() { return dragging; } };
  }

  /* ----------------------------------------------------------- video cards
     Cover = a lid over each card. Side cards: lid closed. Centre card:
     video plays (muted), then the lid fades (.is-revealed) and hides
     (.is-hidden). Moving closes every lid instantly and pauses the video. */
  function setupCards(el, sw, scope, state) {
    const A = (n, d) => el.getAttribute("data-fx-" + n) || d;
    const S = {
      lid: A("lid", ".image-wrap-bts, .title-bts-wrap"),   // fade away on the playing card
      video: A("video", "video"),
      play: A("play", ".play-wrapper"), stop: A("stop", ".stop-wrapper"),
      mute: A("mute", ".audio-mute"), unmute: A("unmute", ".audio-unmute"),
    };
    const FADE = numAttr(el, "data-fx-fade", 500);         // ms, cover + title fade
    const NEIGHBORS = numAttr(el, "data-fx-preload", 1);
    let audioOn = false, userPaused = false, onScreen = true, current = null, pending = null, warm = null;

    const css = document.createElement("style");
    css.textContent = [
      `[data-fx-cards] :is(.control-play-wrapper,.audio-controller-wrapper){pointer-events:none}`,
      `[data-fx-cards] :is(${S.play},${S.stop},${S.mute},${S.unmute}){pointer-events:auto;cursor:pointer}`,
    ].join("");
    document.head.appendChild(css);

    const ensureSrc = (v) => { if (!v.getAttribute("src") && v.dataset.src) v.src = v.dataset.src; };
    const show = (node, on) => { if (node) node.style.display = on ? "flex" : "none"; };
    const uiPlay = (slide, playing) => { show(slide.querySelector(S.play), !playing); show(slide.querySelector(S.stop), playing); };
    // Icon shows the current state: .audio-mute while muted (tap = sound on),
    // .audio-unmute while sound plays (tap = mute).
    const uiAudio = (slide, v) => { show(slide.querySelector(S.mute), v.muted); show(slide.querySelector(S.unmute), !v.muted); };
    const lids = (slide) => slide ? slide.querySelectorAll(S.lid) : [];

    // Lid = cover + title. Open: fade out, then display none. Close: back on top.
    function openLid(slide) {
      for (const l of lids(slide)) {
        clearTimeout(l.__t);
        l.style.display = "";
        l.style.transition = `opacity ${FADE}ms ease`;
        l.style.pointerEvents = "none";
        l.style.opacity = "0";
        l.__t = setTimeout(() => { l.style.display = "none"; }, FADE + 30);
      }
    }
    function closeLid(slide, animate) {
      for (const l of lids(slide)) {
        clearTimeout(l.__t);
        const wasGone = l.style.display === "none";
        l.style.transition = "none";
        l.style.display = "";
        if (animate && wasGone) l.style.opacity = "0";
        void l.offsetWidth;
        l.style.transition = animate ? `opacity ${Math.round(FADE * 0.7)}ms ease` : "none";
        l.style.opacity = "1";
        l.style.pointerEvents = "";
      }
    }
    function preloadAround() {
      const n = sw.slides.length, a = sw.activeIndex;
      for (let d = -NEIGHBORS; d <= NEIGHBORS; d++) {
        const s = sw.slides[(a + d + n) % n], v = s && s.querySelector(S.video);
        if (v) { ensureSrc(v); if (v.preload !== "auto") v.preload = "auto"; }
      }
    }
    // While the slider is still landing, start the next card's video (muted, hidden
    // under its cover) so it is already playing when the slider stops.
    function warmUp() {
      if (!onScreen || document.hidden) return;
      const slide = sw.slides[sw.activeIndex]; if (!slide || slide === current) return;
      const v = slide.querySelector(S.video); if (!v) return;
      if (warm && warm !== v && warm !== (current && current.querySelector(S.video))) warm.pause();
      warm = v;
      ensureSrc(v); v.preload = "auto"; v.muted = true;
      try { v.currentTime = 0; } catch (e) {}              // warm up from the very start
      v.play().catch(() => {});
    }
    function play(slide, restart) {
      const v = slide.querySelector(S.video); if (!v) return;
      ensureSrc(v);
      // A card that just became the centre always starts from 0:00 (under its cover).
      if (restart && v.currentTime > 0) { try { v.currentTime = 0; } catch (e) {} }
      v.muted = !audioOn;
      if (pending) pending.v.removeEventListener("playing", pending.fn);
      const fn = () => { if (current === slide && state.settled) openLid(slide); };
      pending = { v, fn };
      // Reveal only once frame 0:00 is really on screen (after the jump back has finished).
      const ready = () => !v.paused && !v.seeking && v.readyState >= 3;
      if (ready()) fn();                                      // already warmed up: reveal right away
      else { v.addEventListener("playing", fn, { once: true }); v.addEventListener("seeked", () => { if (ready()) fn(); }, { once: true }); }
      v.play().then(() => { if (ready()) fn(); }).catch(() => {
        // Sound blocked (e.g. iPhone after a swipe): keep playing muted.
        if (!v.muted) { v.muted = true; audioOn = false; uiAudio(slide, v); v.play().catch(() => {}); }
        else uiPlay(slide, false);
      });
      uiPlay(slide, true); uiAudio(slide, v);
    }
    function activate() {
      const slide = sw.slides[sw.activeIndex]; if (!slide) return;
      current = slide;
      preloadAround();
      if (!onScreen || document.hidden || userPaused) { uiPlay(slide, false); return; }
      play(slide, true);
    }
    function deactivate() {
      if (pending) { pending.v.removeEventListener("playing", pending.fn); pending = null; }
      for (const s of sw.slides) {
        closeLid(s, false);                                   // cover back instantly
        const v = s.querySelector(S.video);
        if (v && !v.paused && v !== warm) v.pause();
        uiPlay(s, false);
      }
      current = null; userPaused = false;
    }

    el.addEventListener("fx:moving", deactivate);
    el.addEventListener("fx:settled", activate);
    sw.on("slideChange", () => { if (!state.dragging) warmUp(); });
    sw.on("transitionStart", warmUp);

    el.addEventListener("click", (e) => {
      if (!current) return;
      const t = e.target, v = current.querySelector(S.video);
      if (!v || !current.contains(t)) return;
      if (t.closest(S.play)) { userPaused = false; play(current); }
      else if (t.closest(S.stop)) { v.pause(); userPaused = true; uiPlay(current, false); }
      else if (t.closest(S.mute)) { v.muted = false; audioOn = true; uiAudio(current, v); if (v.paused && !userPaused) play(current); }
      else if (t.closest(S.unmute)) { v.muted = true; audioOn = false; uiAudio(current, v); }
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver((en) => {
        onScreen = en[0].isIntersecting;
        if (!current) return;
        const v = current.querySelector(S.video);
        if (!onScreen) { if (v) v.pause(); uiPlay(current, false); }
        else if (!userPaused) play(current);
      }, { threshold: 0.25 }).observe(scope);
    }
    document.addEventListener("visibilitychange", () => {
      if (!current) return;
      const v = current.querySelector(S.video);
      if (document.hidden) { if (v) v.pause(); uiPlay(current, false); }
      else if (onScreen && !userPaused) play(current);
    });

    for (const s of sw.slides) closeLid(s, false);
    if (state.settled) activate();
  }

// Videos load nothing until needed: src → data-src, preload none.
  function quietVideos(el) {
    for (const v of el.querySelectorAll("video")) {
      const s = v.getAttribute("src");
      if (s) { v.dataset.src = s; v.removeAttribute("src"); try { v.load(); } catch (e) {} }
      v.preload = "none"; v.muted = true; v.playsInline = true; v.setAttribute("playsinline", "");
      v.removeAttribute("autoplay");
    }
  }

  /* ---------------------------------------------------------------- boot */
  function boot(el) {
    if (el.__warpFx) return;
    const scope = el.closest("[data-fx-section]") || el.parentElement;
    const imgSel = el.getAttribute("data-fx-images") || "img";
    // WebGL may only read CORS-enabled images; ask for it, and load eagerly
    // so off-screen loop slides are ready.
    for (const img of el.querySelectorAll(imgSel)) {
      img.loading = "eager";
      if (!img.crossOrigin) img.crossOrigin = "anonymous";
    }
    const sw = setupSwiper(el, scope);
    const effects = (el.getAttribute("data-warp-fx") || "edge-warp")
      .split(",").map((s) => s.trim().toLowerCase()).filter((n) => WarpFX.EFFECTS[n]);
    const settings = {}, live = {}, presets = {};
    for (const n of Object.keys(WarpFX.EFFECTS)) {
      const r = readEffect(el, n);
      settings[n] = r.settings; live[n] = r.live; presets[n] = r.preset;
    }
    const D = WarpFX.MOTION_DEFAULTS;
    const motion = {
      zoomOut: numAttr(el, "data-fx-zoom-out", D.zoomOut),
      zoomSpeed: numAttr(el, "data-fx-zoom-speed", D.zoomSpeed),
      fluid: numAttr(el, "data-fx-fluid", D.fluid),
    };
    const bgAttr = el.getAttribute("data-fx-bg");   // "none" = transparent (layers behind stay visible)
    const inst = WarpFX(el, {
      container: scope, effects: effects.length ? effects : ["edge-warp"], settings, live, presets, motion,
      imageSelector: imgSel,
      textSelector: el.getAttribute("data-fx-text") || (el.hasAttribute("data-fx-cards") ? ".title-bts-wrap > *" : ""),
      overlaySelector: el.getAttribute("data-fx-overlay") || (el.hasAttribute("data-fx-cards") ? ".gradient" : ""),
      background: bgAttr === "none" || bgAttr === "transparent" ? null : (bgAttr || undefined),
    });
    el.__warpFx = inst;
    (window.WarpFXInstances = window.WarpFXInstances || []).push(inst);
    if (sw) {
      const state = trackSettled(el, sw, inst);
      if (el.hasAttribute("data-fx-cards")) setupCards(el, sw, scope, state);
    }
  }

  // Lazy: nothing heavy happens until the section is about one screen away.
  function start() {
    for (const el of document.querySelectorAll("[data-warp-fx]")) {
      if (el.hasAttribute("data-fx-cards")) quietVideos(el);
      const needsSwiper = el.getAttribute("data-fx-swiper") !== "false" && !window.Swiper;
      const go = () => (needsSwiper ? loadScript(el.getAttribute("data-fx-swiper-src") || SWIPER_SRC) : Promise.resolve())
        .then(() => boot(el)).catch((e) => console.warn(e));
      if (el.getAttribute("data-fx-lazy") === "false" || !("IntersectionObserver" in window)) { go(); continue; }
      const target = el.closest("[data-fx-section]") || el;
      const io = new IntersectionObserver((en) => {
        if (en.some((x) => x.isIntersecting)) { io.disconnect(); go(); }
      }, { rootMargin: "100% 0px" });
      io.observe(target);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
