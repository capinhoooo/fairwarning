import { useLayoutEffect, useRef } from 'react'
import { reducedMotion, registerGsap, splitGrad } from '@/lib/motion'

interface Props {
  index: string
  eyebrow: string
  title: React.ReactNode
  /** changes when the title text changes, so the split heading is rebuilt instead of patched */
  titleKey?: string
  sub?: React.ReactNode
  hud?: React.ReactNode
}

/** Page title in the landing page's voice: lines rise out of masks, then a horizon with its lamp draws in. */
export default function PageHead({
  index,
  eyebrow,
  title,
  titleKey,
  sub,
  hud,
}: Props) {
  const root = useRef<HTMLDivElement>(null)
  const h1 = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => {
    const el = h1.current!
    if (reducedMotion()) return
    const { gsap } = registerGsap()
    let cancelled = false
    const ctx = gsap.context(() => {})
    document.fonts.ready.then(() => {
      if (cancelled) return
      ctx.add(() => {
        const lines = splitGrad(el, 'lines')
        gsap.from(lines, {
          yPercent: 115,
          duration: 1.2,
          ease: 'expo.out',
          stagger: 0.09,
        })
        gsap.from(root.current!.querySelectorAll('.eyebrow, .sub, .hudr'), {
          opacity: 0,
          y: 12,
          duration: 0.9,
          ease: 'power3.out',
          stagger: 0.06,
          delay: 0.15,
        })
      })
    })
    return () => {
      cancelled = true
      ctx.revert()
    }
  }, [titleKey])

  return (
    <div ref={root}>
      <div className="phead">
        <div>
          <span className="eyebrow">
            <span className="text-light">{index}</span> {eyebrow}
          </span>
          <h1 className="grad" ref={h1} key={titleKey}>
            {title}
          </h1>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {hud && <div className="hudr">{hud}</div>}
      </div>
      <div className="horizon" aria-hidden="true">
        <span className="cone" />
        <span className="lamp" />
      </div>
    </div>
  )
}
