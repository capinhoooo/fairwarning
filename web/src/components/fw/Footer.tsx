import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { LogoMark } from '@/components/fw/Nav'
import { useChainClock } from '@/hooks/useFw'
import { scrollToTarget } from '@/lib/lenis'
import { reducedMotion, registerGsap } from '@/lib/motion'
import { config } from '@/config'
import { fmtInt } from '@/utils/fw'

const ext = { target: '_blank', rel: 'noopener noreferrer' }

export default function Footer() {
  const foot = useRef<HTMLElement>(null)
  const mark = useRef<HTMLSpanElement>(null)
  const status = useRef<HTMLElement>(null)
  const clock = useChainClock()

  useEffect(() => {
    const id = setInterval(() => {
      const b = clock.base()
      if (status.current)
        status.current.textContent = b === null ? '…' : `#${fmtInt(b)}`
    }, 200)
    return () => clearInterval(id)
  }, [clock.base])

  // the wordmark always spans the page edge to edge, whatever the font metrics and width
  useEffect(() => {
    const m = mark.current!
    const fit = () => {
      m.style.fontSize = '100px'
      const w = m.getBoundingClientRect().width,
        avail = m.parentElement!.clientWidth - 24
      if (w > 0) m.style.fontSize = `${Math.floor((100 * avail) / w)}px`
    }
    document.fonts.ready.then(fit)
    const ro = new ResizeObserver(fit)
    ro.observe(m.parentElement!)
    return () => ro.disconnect()
  }, [])

  // the wordmark surfaces from the sea as you arrive, then the beam's glint crosses it
  useEffect(() => {
    if (reducedMotion()) return
    const { gsap, ScrollTrigger } = registerGsap()
    const ctx = gsap.context(() => {
      const m = mark.current!
      gsap.fromTo(
        m,
        { clipPath: 'inset(100% 0 0 0)', yPercent: 24 },
        {
          clipPath: 'inset(0% 0 0 0)',
          yPercent: 0,
          ease: 'none',
          scrollTrigger: {
            trigger: foot.current,
            start: 'top bottom',
            end: 'top 45%',
            scrub: 0.6,
          },
        },
      )
      const glint = () =>
        gsap.fromTo(
          m,
          { '--g2': '-240px' },
          {
            '--g2': `${m.getBoundingClientRect().width + 240}px`,
            duration: 2.2,
            ease: 'power2.inOut',
          },
        )
      ScrollTrigger.create({
        trigger: foot.current,
        start: 'top 55%',
        onEnter: glint,
        onEnterBack: glint,
      })
      gsap.from('.foot-grid > *, .legal', {
        y: 20,
        stagger: 0.08,
        duration: 0.9,
        ease: 'expo.out',
        scrollTrigger: { trigger: '.foot-grid', start: 'top 90%' },
      })
    }, foot)
    return () => ctx.revert()
  }, [])

  return (
    <footer className="foot" ref={foot}>
      <div className="mark-wrap" aria-hidden="true">
        <span className="mark" ref={mark}>
          Fair <em className="serif">Warning</em>
        </span>
      </div>
      <div className="wrap">
        <div className="foot-grid">
          <div className="sign">
            <LogoMark />
            <p className="sign-l">
              Give notice. <em className="serif">Or pay.</em>
            </p>
            <span className="status">
              <i />
              Watching Base <b ref={status}>…</b>
            </span>
            <span className="eyebrow">
              Verified by NEAR MPC · {config.fw.mpcContractId}
            </span>
          </div>
          <nav className="cols" aria-label="Footer">
            <div>
              <span className="eyebrow">Product</span>
              <Link to="/bonds">Bonded vaults</Link>
              <Link to="/report">Report a breach</Link>
              <Link to="/bond/new">Post a bond</Link>
            </div>
            <div>
              <span className="eyebrow">Built on</span>
              <a href="https://near.org" {...ext}>
                NEAR
              </a>
              <a href="https://github.com/near/mpc" {...ext}>
                NEAR MPC
              </a>
              <a href="https://docs.near-intents.org" {...ext}>
                NEAR Intents
              </a>
              <a href="https://base.org" {...ext}>
                Base
              </a>
            </div>
            <div>
              <span className="eyebrow">Hackathon</span>
              <a href="https://nearhackathon.com" {...ext}>
                NEAR HACKATHON
              </a>
              {config.links.github && (
                <a href={config.links.github} {...ext}>
                  Source
                </a>
              )}
              <span className="plain">Tracks: DeFi, Open</span>
            </div>
          </nav>
        </div>
        <div className="legal">
          <span>© 2026 Fair Warning · MIT licence</span>
          <button type="button" onClick={() => scrollToTarget(0)}>
            Back to top ↑
          </button>
        </div>
      </div>
    </footer>
  )
}
