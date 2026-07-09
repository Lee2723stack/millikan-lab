// WebGL 流体背景 — 精简版 LiquidEther
(function() {
  const container = document.getElementById('auth-page');
  if (!container) return;
  container.style.position = 'relative';
  container.style.overflow = 'hidden';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none;';
  container.prepend(canvas);

  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false });
  if (!gl) { canvas.style.display = 'none'; return; }

  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) { canvas.style.display = 'none'; return; }

  // Shaders
  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('Shader error:', gl.getShaderInfoLog(s));
    }
    return s;
  }
  function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  const vs = `#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0,1);}`;
  const advectFS = `#version 300 es\nprecision highp float;
uniform sampler2D vel;uniform vec2 px;uniform float dt;
in vec2 uv;out vec2 o;
void main(){vec2 v=texture(vel,uv).xy;o=texture(vel,uv-v*dt/px).xy;}`;

  const splatFS = `#version 300 es\nprecision highp float;
uniform vec2 force,center,px;in vec2 uv;out vec4 o;
void main(){vec2 d=(uv-.5)*2.;float w=1.-min(length(d),1.);w*=w;o=vec4(force*w,0,1);}`;

  const divergenceFS = `#version 300 es\nprecision highp float;
uniform sampler2D vel;uniform vec2 px;in vec2 uv;out float o;
void main(){o=(texture(vel,uv+vec2(px.x,0)).x-texture(vel,uv-vec2(px.x,0)).x+texture(vel,uv+vec2(0,px.y)).y-texture(vel,uv-vec2(0,px.y)).y)*.5;}`;

  const pressureFS = `#version 300 es\nprecision highp float;
uniform sampler2D p_in,div;uniform vec2 px;in vec2 uv;out float o;
void main(){o=(texture(p_in,uv+vec2(px.x*2.,0)).r+texture(p_in,uv-vec2(px.x*2.,0)).r+texture(p_in,uv+vec2(0,px.y*2.)).r+texture(p_in,uv-vec2(0,px.y*2.)).r-texture(div,uv).r)*.25;}`;

  const subtractFS = `#version 300 es\nprecision highp float;
uniform sampler2D vel,p_in;uniform vec2 px;in vec2 uv;out vec2 o;
void main(){vec2 v=texture(vel,uv).xy;float p0=texture(p_in,uv+vec2(px.x,0)).r,p1=texture(p_in,uv-vec2(px.x,0)).r,p2=texture(p_in,uv+vec2(0,px.y)).r,p3=texture(p_in,uv-vec2(0,px.y)).r;o=v-vec2(p0-p1,p2-p3)*.5;}`;

  const colorFS = `#version 300 es\nprecision highp float;
uniform sampler2D vel;uniform vec3 c1,c2,c3;in vec2 uv;out vec4 o;
void main(){float l=clamp(length(texture(vel,uv).xy),0.,1.);vec3 c=mix(c1,c2,l);c=mix(c,c3,l*l);o=vec4(c,l*.25);}`;

  const advectProg = createProgram(vs, advectFS);
  const splatProg = createProgram(vs, splatFS);
  const divProg = createProgram(vs, divergenceFS);
  const pressureProg = createProgram(vs, pressureFS);
  const subtractProg = createProgram(vs, subtractFS);
  const colorProg = createProgram(vs, colorFS);

  // Render targets
  function createTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function createFBO(w, h, tex) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex || createTex(w, h), 0);
    return fbo;
  }

  let W, H;
  function resize() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, Math.floor(r.width * 0.5));
    H = Math.max(1, Math.floor(r.height * 0.5));
    canvas.width = r.width;
    canvas.height = r.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  const vel0 = createTex(W, H), vel1 = createTex(W, H);
  const divTex = createTex(W, H), p0 = createTex(W, H), p1 = createTex(W, H);
  const fboVel0 = createFBO(W, H, vel0), fboVel1 = createFBO(W, H, vel1);
  const fboDiv = createFBO(W, H, divTex), fboP0 = createFBO(W, H, p0), fboP1 = createFBO(W, H, p1);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

  function draw(prog, fbo, uniforms) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    if (uniforms) uniforms(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Auto driver + mouse
  let mouseX = 0, mouseY = 0, mouseDown = false;

  container.addEventListener('mousemove', e => {
    const r = container.getBoundingClientRect();
    mouseX = (e.clientX - r.left) / r.width * 2 - 1;
    mouseY = -(e.clientY - r.top) / r.height * 2 + 1;
  });
  container.addEventListener('mouseleave', () => { mouseX = 0; mouseY = 0; });
  container.addEventListener('touchmove', e => {
    e.preventDefault();
    const r = container.getBoundingClientRect();
    const t = e.touches[0];
    mouseX = (t.clientX - r.left) / r.width * 2 - 1;
    mouseY = -(t.clientY - r.top) / r.height * 2 + 1;
  }, { passive: false });

  let lastTime = performance.now();
  let autoX = 0, autoY = 0, autoTargetX = 0, autoTargetY = 0, autoTimer = 0;

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    // Auto driver
    autoTimer -= dt;
    if (autoTimer <= 0) {
      autoTargetX = (Math.random() - 0.5) * 1.6;
      autoTargetY = (Math.random() - 0.5) * 1.6;
      autoTimer = 2 + Math.random() * 3;
    }
    const autoSpeed = 0.3;
    autoX += (autoTargetX - autoX) * autoSpeed * dt;
    autoY += (autoTargetY - autoY) * autoSpeed * dt;

    const fx = mouseX || autoX;
    const fy = mouseY || autoY;

    const px = [1/W, 1/H];

    // Advection
    draw(advectProg, fboVel1, p => {
      gl.uniform1i(gl.getUniformLocation(p, 'vel'), 0);
      gl.uniform2fv(gl.getUniformLocation(p, 'px'), px);
      gl.uniform1f(gl.getUniformLocation(p, 'dt'), dt);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vel0);
    });

    // Splat
    draw(splatProg, fboVel1, p => {
      gl.uniform2f(gl.getUniformLocation(p, 'force'), fx * 10, fy * 10);
      gl.uniform2f(gl.getUniformLocation(p, 'center'), fx, fy);
      gl.uniform2fv(gl.getUniformLocation(p, 'px'), px);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    });
    gl.disable(gl.BLEND);

    // Swap vel
    [vel0, vel1, fboVel0, fboVel1] = [vel1, vel0, fboVel1, fboVel0];

    // Divergence
    draw(divProg, fboDiv, p => {
      gl.uniform1i(gl.getUniformLocation(p, 'vel'), 0);
      gl.uniform2fv(gl.getUniformLocation(p, 'px'), px);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vel0);
    });

    // Pressure (32 iter)
    for (let i = 0; i < 32; i++) {
      const src = i % 2 === 0 ? fboP1 : fboP0;
      const dst = i % 2 === 0 ? fboP0 : fboP1;
      draw(pressureProg, dst, p => {
        gl.uniform1i(gl.getUniformLocation(p, 'p_in'), 0);
        gl.uniform1i(gl.getUniformLocation(p, 'div'), 1);
        gl.uniform2fv(gl.getUniformLocation(p, 'px'), px);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, i % 2 === 0 ? p1 : p0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, divTex);
      });
    }

    // Subtract pressure
    draw(subtractProg, fboVel1, p => {
      gl.uniform1i(gl.getUniformLocation(p, 'vel'), 0);
      gl.uniform1i(gl.getUniformLocation(p, 'p_in'), 1);
      gl.uniform2fv(gl.getUniformLocation(p, 'px'), px);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vel0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, 32 % 2 === 0 ? p0 : p1);
    });
    [vel0, vel1, fboVel0, fboVel1] = [vel1, vel0, fboVel1, fboVel0];

    // Render color
    draw(colorProg, null, p => {
      gl.uniform1i(gl.getUniformLocation(p, 'vel'), 0);
      gl.uniform3f(gl.getUniformLocation(p, 'c1'), 0.20, 0.10, 0.45); // deep purple
      gl.uniform3f(gl.getUniformLocation(p, 'c2'), 0.10, 0.20, 0.55); // deep blue
      gl.uniform3f(gl.getUniformLocation(p, 'c3'), 0.45, 0.15, 0.55); // violet
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vel0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    });

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
  window.addEventListener('resize', resize);
})();
