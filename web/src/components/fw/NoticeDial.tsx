import { useEffect, useRef } from 'react'
import { cssVar, reducedMotion } from '@/lib/motion'
import { BASE_BLOCK_S, fmtInt } from '@/utils/fw'

const TAU = Math.PI * 2
const TICKS = 180
const LAP_S = 12 // the hand sweeps one lap per 60 Base blocks, smoothly, never ticking

interface Props {
  /** live head of the watched chain, or null until the first read */
  block: () => number | null
  /** block from which the change is allowed; null draws an idle dial */
  target: number | null
  notice: number
  idleText?: string
  tilt?: boolean
  label?: string
  /** seconds per block on the watched chain; null shows blocks only */
  blockS?: number | null
}

const buildOdo = (el: HTMLElement, s: string) => {
  el.textContent = ''
  for (const ch of s) {
    if (ch === ',') {
      const c = document.createElement('span')
      c.className = 'comma'
      c.textContent = ','
      el.appendChild(c)
      continue
    }
    const col = document.createElement('span')
    col.className = 'odo'
    const strip = document.createElement('span')
    for (let d = 0; d < 10; d++) {
      const i = document.createElement('i')
      i.textContent = String(d)
      strip.appendChild(i)
    }
    col.appendChild(strip)
    el.appendChild(col)
  }
}

const setOdo = (el: HTMLElement, n: number) => {
  const s = n.toLocaleString('en-US'),
    digits = s.replace(/,/g, '')
  if (el.querySelectorAll('.odo').length !== digits.length) buildOdo(el, s)
  // the strips hold 0 to 9 each; screen readers get the number, not the strips
  el.setAttribute('aria-label', s)
  el.querySelectorAll<HTMLElement>('.odo > span').forEach((strip, k) => {
    strip.style.transform = `translateY(-${Number(digits[k])}em)`
  })
}

const remaining = (rem: number, blockS: number | null) => {
  if (!blockS) return `${fmtInt(rem)} blocks`
  const s = rem * blockS
  return `${fmtInt(rem)} blocks · ${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** The notice clock: a hand carrying a light circles the dial while Base blocks arrive; the arc is the notice served. */
export default function NoticeDial({
  block,
  target,
  notice,
  idleText = 'No change announced',
  tilt,
  label = 'Base block',
  blockS = BASE_BLOCK_S,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const odo = useRef<HTMLDivElement>(null)
  const left = useRef<HTMLDivElement>(null)
  const props = useRef({ block, target, notice, idleText, blockS })
  props.current = { block, target, notice, idleText, blockS }

  useEffect(() => {
    const canvas = cvs.current!,
      ctx = canvas.getContext('2d')!
    const reduce = reducedMotion()
    let size = 0,
      hand = 0,
      last = performance.now(),
      shown = -1,
      raf = 0,
      visible = false

    const draw = () => {
      if (!size) return
      const { block: getBlock, target: tgt, notice: N } = props.current
      const b = getBlock()
      const c = size / 2,
        R = size * 0.46,
        RI = R * 0.6
      const lightC = cssVar('--light'),
        fg3 = cssVar('--fg-3'),
        line = cssVar('--line-2'),
        fgC = cssVar('--fg')
      // one moving element: the hand and the light it carries; everything moving stays outside the readout bezel
      const h = hand - Math.PI / 2
      ctx.clearRect(0, 0, size, size)
      ctx.lineCap = 'round'
      ctx.strokeStyle = line
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(c, c, R, 0, TAU)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(c, c, RI, 0, TAU)
      ctx.stroke()
      const trail = ctx.createRadialGradient(c, c, RI, c, c, R)
      trail.addColorStop(0, 'rgba(0,0,0,0)')
      trail.addColorStop(1, cssVar('--light-soft'))
      ctx.fillStyle = trail
      ctx.beginPath()
      ctx.arc(c, c, R, h - 0.5, h)
      ctx.arc(c, c, RI, h, h - 0.5, true)
      ctx.closePath()
      ctx.fill()
      // ticks light up as the hand passes and fade behind it
      for (let i = 0; i < TICKS; i++) {
        const a = (i / TICKS) * TAU - Math.PI / 2
        const behind = (((h - a) % TAU) + TAU) % TAU
        const glow = Math.exp(-behind * 2.4)
        const major = (i + (b ?? 0)) % 10 === 0
        const r1 = R - (major ? 20 : 9) - glow * 6
        ctx.strokeStyle = glow > 0.05 ? lightC : fg3
        ctx.globalAlpha = Math.min(1, (major ? 0.7 : 0.32) + glow)
        ctx.lineWidth = major ? 1.6 : 1
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1)
        ctx.lineTo(c + Math.cos(a) * (R - 2), c + Math.sin(a) * (R - 2))
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      // the notice: a progress arc with a glowing marker where the notice stands now
      const a0 = -Math.PI / 2,
        RA = R * 0.78
      ctx.strokeStyle = line
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.arc(c, c, RA, 0, TAU)
      ctx.stroke()
      if (tgt !== null && b !== null) {
        const done = 1 - Math.min(N, Math.max(0, tgt - b)) / N
        const g = ctx.createLinearGradient(c - RA, c, c + RA, c)
        g.addColorStop(0, cssVar('--grad-b'))
        g.addColorStop(1, lightC)
        ctx.strokeStyle = g
        ctx.beginPath()
        ctx.arc(c, c, RA, a0, a0 + TAU * Math.max(done, 0.006))
        ctx.stroke()
        ctx.fillStyle = fgC
        ctx.beginPath()
        ctx.arc(c, c + Math.sin(a0) * RA, 3.5, 0, TAU)
        ctx.fill()
        const ah = a0 + TAU * done
        ctx.save()
        ctx.shadowColor = lightC
        ctx.shadowBlur = 14
        ctx.strokeStyle = lightC
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(ah) * R * 0.7, c + Math.sin(ah) * R * 0.7)
        ctx.lineTo(c + Math.cos(ah) * R * 0.86, c + Math.sin(ah) * R * 0.86)
        ctx.stroke()
        ctx.fillStyle = lightC
        ctx.beginPath()
        ctx.arc(c + Math.cos(ah) * RA, c + Math.sin(ah) * RA, 5, 0, TAU)
        ctx.fill()
        ctx.restore()
      }
      // the hand itself, in the outer ring only, with a lit tip
      ctx.strokeStyle = fgC
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(c + Math.cos(h) * R * 0.64, c + Math.sin(h) * R * 0.64)
      ctx.lineTo(c + Math.cos(h) * R * 0.95, c + Math.sin(h) * R * 0.95)
      ctx.stroke()
      ctx.save()
      ctx.shadowColor = lightC
      ctx.shadowBlur = 12
      ctx.fillStyle = lightC
      ctx.beginPath()
      ctx.arc(c + Math.cos(h) * R * 0.95, c + Math.sin(h) * R * 0.95, 3, 0, TAU)
      ctx.fill()
      ctx.restore()
    }

    const readout = () => {
      const {
        block: getBlock,
        target: tgt,
        idleText: idle,
        blockS: bs,
      } = props.current
      const b = getBlock()
      if (b === null) {
        if (odo.current && shown !== -2) {
          odo.current.textContent = 'Reading the chain…'
          odo.current.setAttribute('aria-label', 'Reading the chain')
        }
        shown = -2
        return
      }
      if (b !== shown && odo.current) setOdo(odo.current, b)
      shown = b
      if (left.current)
        left.current.textContent =
          tgt === null
            ? idle
            : tgt > b
              ? `${remaining(tgt - b, bs)} to go`
              : 'Notice served'
    }

    const resize = () => {
      const rc = canvas.getBoundingClientRect(),
        dpr = Math.min(devicePixelRatio || 1, 2)
      size = rc.width
      canvas.width = size * dpr
      canvas.height = size * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
    io.observe(canvas)
    const iv = setInterval(readout, reduce ? 1000 : 200)
    readout()
    if (reduce) {
      const still = setInterval(draw, 1000)
      return () => {
        clearInterval(still)
        clearInterval(iv)
        ro.disconnect()
        io.disconnect()
      }
    }
    const spin = (now: number) => {
      hand += ((now - last) / 1000) * (TAU / LAP_S)
      last = now
      if (visible) draw()
      raf = requestAnimationFrame(spin)
    }
    raf = requestAnimationFrame(spin)

    // the dial leans toward the pointer like an instrument on a gimbal
    const w = wrap.current!
    const onMove = (e: PointerEvent) => {
      const r = w.getBoundingClientRect()
      const ry = ((e.clientX - (r.left + r.width / 2)) / r.width) * 12
      const rx = -((e.clientY - (r.top + r.height / 2)) / r.height) * 12
      w.style.transform = `perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`
    }
    const onLeave = () => (w.style.transform = 'perspective(1000px)')
    const host = tilt ? (w.closest('section') ?? w) : null
    if (host) {
      w.style.transition = 'transform .9s cubic-bezier(.2, .8, .2, 1)'
      host.addEventListener('pointermove', onMove as EventListener)
      host.addEventListener('pointerleave', onLeave)
    }
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(iv)
      ro.disconnect()
      io.disconnect()
      host?.removeEventListener('pointermove', onMove as EventListener)
      host?.removeEventListener('pointerleave', onLeave)
    }
  }, [tilt])

  return (
    <div className="dial-wrap" ref={wrap}>
      <canvas
        ref={cvs}
        role="img"
        aria-label={`Notice clock: a hand circles the dial as each ${label} arrives; the arc shows how much of the promised notice has been served`}
      />
      <div className="readout">
        <span className="eyebrow">{label}</span>
        <div className="big mono odometer" ref={odo} role="img" aria-live="off" />
        <div className="left eyebrow" ref={left} />
      </div>
    </div>
  )
}
