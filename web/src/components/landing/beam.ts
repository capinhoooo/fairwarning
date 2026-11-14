import { cssVar, isDarkTheme } from '@/lib/motion'

export interface Light {
  lx: number
  on: number
}

const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'
const FS = `precision highp float;
uniform vec2 r;uniform float t;uniform vec2 m;uniform float dk;uniform float ang;uniform float lx;uniform float on;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p*=2.02;a*=.5;}return v;}
void main(){
  vec2 q=(gl_FragCoord.xy-.5*r)/r.y; q.x+=m.x*.03;
  float hz=.08+m.y*.015; const float TOWER=.075; vec2 src=vec2(lx,hz+TOWER+.006);
  vec3 skyTop=mix(vec3(.984,.984,.98),vec3(0.),dk);
  vec3 skyLow=mix(vec3(.985,.955,.915),vec3(.03,.026,.022),dk);
  vec3 seaNear=mix(vec3(.915,.922,.932),vec3(0.),dk);
  vec3 seaFar=mix(vec3(.984,.984,.98),vec3(0.),dk);
  vec3 sea=mix(seaFar,seaNear,smoothstep(-.5,hz,q.y));
  vec3 beamC=mix(vec3(1.,.66,.28),vec3(1.,.86,.62),dk);
  float above=step(hz,q.y);
  vec3 col=mix(sea,mix(skyLow,skyTop,smoothstep(hz,hz+.3,q.y)),above);
  vec2 sg=floor(gl_FragCoord.xy/2.5); float st=step(.998,h(sg))*above*dk*smoothstep(hz+.08,hz+.45,q.y);
  col+=st*.7*(.5+.5*sin(t*2.+h(sg)*40.));
  float fog=fbm(vec2(q.x*2.2+t*.03,q.y*5.-t*.02));
  vec2 d=q-src; float a=atan(d.y,d.x); float dist=length(d);
  float w=.05+dist*.02; float da=abs(a-ang);
  float beam=smoothstep(w,0.,da)*above*exp(-dist*.95);
  beam*=.55+.45*fbm(vec2(dist*5.-t*.4,a*8.));
  float glow=exp(-dist*mix(46.,30.,dk));
  float hline=exp(-abs(q.y-hz)*200.)*(1.-smoothstep(0.,1.1,abs(q.x-lx)));
  float wave=fbm(vec2(q.x*30.,q.y*140.+t*.6));
  float refl=(1.-above)*exp(-abs(q.x-lx-cos(ang)*.35*(hz-q.y)*4.)*9.)*exp(-(hz-q.y)*6.)*smoothstep(.45,.75,wave);
  float L=(fog*.045*above*(1.-smoothstep(hz,hz+.35,q.y))+beam*1.15+glow*1.25+hline*.16+refl*.38)*on;
  vec3 night=col+beamC*L;
  vec3 dawn=mix(col,vec3(.99,.62,.26),clamp(L*.55,0.,.72));
  col=mix(dawn,night,dk);
  float ty=(q.y-hz)/TOWER; float tw=mix(.011,.0055,clamp(ty,0.,1.));
  float tower=step(0.,ty)*step(ty,1.)*(1.-smoothstep(tw-.0015,tw,abs(q.x-lx)));
  vec3 towerC=mix(vec3(.1,.1,.11),vec3(.05,.045,.04),dk)+beamC*exp(-(1.-ty)*5.)*mix(.18,.3,dk)*on;
  col=mix(col,towerC,tower);
  col+=(h(gl_FragCoord.xy+t)-.5)*.02;
  gl_FragColor=vec4(max(col,0.),1.);}`

const HEX = '0123456789abcdef'
const CW = 13
const CH = 17

/**
 * The hero: a WebGL lighthouse on a night sea, and a canvas2d layer of hex glyphs (the alphabet of the hash
 * the MPC signs) that shows only where the beam falls. Both use the same geometry. Returns a cleanup.
 */
export const startBeam = (
  cvs: HTMLCanvasElement,
  gcv: HTMLCanvasElement,
  light: Light,
  reduce: boolean,
) => {
  const gl = cvs.getContext('webgl', { antialias: false })
  const gctx = gcv.getContext('2d')
  let beamAngle = 1.75
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
  const lampX = () => {
    const rc = cvs.getBoundingClientRect(),
      asp = rc.width / Math.max(rc.height, 1)
    return asp > 1 ? Math.min(0.3 * asp, 0.62) : 0.1
  }
  let cols = 0,
    rows = 0,
    cells: Array<string> = []
  const drawGlyphs = () => {
    const W = gcv.clientWidth,
      H = gcv.clientHeight
    if (!gctx || !W || !H) return
    gctx.clearRect(0, 0, W, H)
    if (light.on < 0.05) return
    gctx.font = '500 11px "JetBrains Mono Variable", monospace'
    gctx.textAlign = 'center'
    gctx.textBaseline = 'middle'
    gctx.fillStyle = cssVar('--light')
    const hz = 0.08 + mouse.y * 0.015,
      sy = hz + 0.081,
      lx = light.lx
    for (let r = 0; r < rows; r++) {
      const y = r * CH + CH / 2,
        qy = (H / 2 - y) / H
      if (qy <= hz + 0.012) continue
      for (let c = 0; c < cols; c++) {
        const x = c * CW + CW / 2,
          qx = (x - W / 2) / H + mouse.x * 0.03
        const dx = qx - lx,
          dy = qy - sy,
          dist = Math.hypot(dx, dy)
        if (dist < 0.07) continue
        // a band a little wider than the beam, so the data reads as a halo around the light
        const band = (0.05 + dist * 0.02) * 1.8,
          da = Math.abs(Math.atan2(dy, dx) - beamAngle)
        if (da > band) continue
        const k =
          Math.pow(1 - da / band, 1.4) * Math.exp(-dist * 0.8) * light.on
        if (k < 0.04) continue
        const i = r * cols + c
        if (!reduce && Math.random() < 0.05)
          cells[i] = HEX[(Math.random() * 16) | 0]
        gctx.globalAlpha = Math.min(0.8, k * 2)
        gctx.fillText(cells[i], x, y)
      }
    }
    gctx.globalAlpha = 1
  }
  const gro = new ResizeObserver(() => {
    if (!gctx) return
    const rc = gcv.getBoundingClientRect(),
      dpr = Math.min(devicePixelRatio || 1, 2)
    gcv.width = rc.width * dpr
    gcv.height = rc.height * dpr
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.ceil(rc.width / CW)
    rows = Math.ceil(rc.height / CH)
    cells = Array.from(
      { length: cols * rows },
      () => HEX[(Math.random() * 16) | 0],
    )
    drawGlyphs()
  })
  gro.observe(gcv)

  const cleanups: Array<() => void> = [() => gro.disconnect()]
  if (gl) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.useProgram(prog)
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      )
      const loc = gl.getAttribLocation(prog, 'p')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      const U = Object.fromEntries(
        ['r', 't', 'm', 'dk', 'ang', 'lx', 'on'].map((k) => [
          k,
          gl.getUniformLocation(prog, k),
        ]),
      )
      let dk = isDarkTheme() ? 1 : 0,
        visible = true,
        fc = 0,
        raf = 0
      const resize = () => {
        const rc = cvs.getBoundingClientRect(),
          dpr = Math.min(devicePixelRatio || 1, 1.5)
        cvs.width = rc.width * dpr
        cvs.height = rc.height * dpr
        gl.viewport(0, 0, cvs.width, cvs.height)
        light.lx = lampX()
      }
      const frame = (ms: number) => {
        mouse.x += (mouse.tx - mouse.x) * 0.04
        mouse.y += (mouse.ty - mouse.y) * 0.04
        dk += ((isDarkTheme() ? 1 : 0) - dk) * (reduce ? 1 : 0.06)
        gl.uniform2f(U.r, cvs.width, cvs.height)
        gl.uniform1f(U.t, ms / 1000 + 8)
        gl.uniform2f(U.m, mouse.x, mouse.y)
        gl.uniform1f(U.dk, dk)
        gl.uniform1f(U.ang, beamAngle)
        gl.uniform1f(U.lx, light.lx)
        gl.uniform1f(U.on, light.on)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      const ro = new ResizeObserver(() => {
        resize()
        if (reduce) {
          frame(0)
          drawGlyphs()
        }
      })
      ro.observe(cvs)
      const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
      io.observe(cvs)
      const onMove = (e: PointerEvent) => {
        mouse.tx = (e.clientX / innerWidth - 0.5) * 2
        mouse.ty = (e.clientY / innerHeight - 0.5) * -2
      }
      addEventListener('pointermove', onMove)
      // a theme switch repaints the still frame when nothing animates
      const mo = new MutationObserver(() => {
        if (!reduce) return
        frame(0)
        drawGlyphs()
      })
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
      })
      resize()
      if (reduce) frame(0)
      else {
        // a slow, weighty sweep that leans toward the open sky; glyphs redraw every other frame
        const loop = (ms: number) => {
          beamAngle = Math.sin((ms / 1000) * 0.18 + 1.2) * 0.95 + 1.85
          if (visible) {
            frame(ms)
            if ((fc++ & 1) === 0) drawGlyphs()
          }
          raf = requestAnimationFrame(loop)
        }
        raf = requestAnimationFrame(loop)
      }
      cleanups.push(() => {
        cancelAnimationFrame(raf)
        ro.disconnect()
        io.disconnect()
        mo.disconnect()
        removeEventListener('pointermove', onMove)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      })
    }
  }
  return () => cleanups.forEach((f) => f())
}
