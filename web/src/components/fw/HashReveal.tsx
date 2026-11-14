import { useEffect, useRef } from 'react'
import { reducedMotion } from '@/lib/motion'

const HEX = '0123456789abcdef'

/** Decodes a hash left to right out of shimmering hex, the way the MPC's answer arrives. */
export default function HashReveal({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  const el = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const node = el.current!
    if (reducedMotion()) {
      node.textContent = value
      return
    }
    const body = value.replace(/^0x/, ''),
      start = performance.now(),
      DUR = 1400
    let raf = 0
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / DUR),
        solid = Math.floor(body.length * k)
      let s = '0x' + body.slice(0, solid)
      for (let i = solid; i < body.length; i++)
        s += HEX[(Math.random() * 16) | 0]
      node.textContent = s
      if (k < 1) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span ref={el} className={className} aria-label={value} />
}
