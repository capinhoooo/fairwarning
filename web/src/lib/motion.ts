import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'

let registered = false

export const registerGsap = () => {
  if (!registered) {
    gsap.registerPlugin(ScrollTrigger, SplitText, MotionPathPlugin)
    registered = true
  }
  return { gsap, ScrollTrigger, SplitText }
}

export const reducedMotion = () =>
  typeof window !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

export const isDarkTheme = () =>
  !document.documentElement.classList.contains('light')

export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * Gradient text goes transparent inside SplitText masks, so each piece paints its own slice of one shared
 * gradient, plus a narrow glint layer that sweeps across via --g.
 */
export const gradPieces = (pieces: Array<HTMLElement>, box: HTMLElement) => {
  const b = box.getBoundingClientRect()
  pieces.forEach((w) => {
    const r = w.getBoundingClientRect()
    Object.assign(w.style, {
      backgroundImage:
        'linear-gradient(90deg, transparent calc(var(--g, -999px) - 140px), var(--glint) var(--g, -999px), transparent calc(var(--g, -999px) + 140px)), linear-gradient(90deg, var(--grad-a) 0%, var(--grad-b) 55%, var(--grad-c) 100%)',
      backgroundSize: `${b.width}px 100%, ${b.width}px 100%`,
      backgroundPosition: `${b.left - r.left}px 0, ${b.left - r.left}px 0`,
      webkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    })
  })
}

/** Splits a .grad heading into masked pieces that keep the gradient; padding keeps descenders inside the masks. */
export const splitGrad = (el: HTMLElement, type: 'lines' | 'words') => {
  const s = SplitText.create(el, { type, mask: type })
  const pieces = (type === 'lines' ? s.lines : s.words) as Array<HTMLElement>
  ;[...((s.masks as Array<HTMLElement> | undefined) ?? []), ...pieces].forEach(
    (m) => {
      m.style.paddingBottom = '.16em'
      m.style.marginBottom = '-.16em'
    },
  )
  gradPieces(pieces, el)
  el.classList.remove('grad')
  return pieces
}
