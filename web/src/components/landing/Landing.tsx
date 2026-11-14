import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { startBeam } from './beam'
import { startFlow } from './flow'
import type { Light } from './beam'
import Cta from '@/components/fw/Cta'
import NoticeDial from '@/components/fw/NoticeDial'
import { useChainClock, useChainInfo, useLatestAnnouncement } from '@/hooks/useFw'
import { getLenis, scrollToTarget } from '@/lib/lenis'
import { reducedMotion, registerGsap, splitGrad } from '@/lib/motion'
import { blocksToTime, describeExpectedLog, fmtInt, fmtUsdc } from '@/utils/fw'
// the splash plays once per page load; coming back to / inside the app goes straight to the hero
let splashPlayed = false

const inPage = (e: React.MouseEvent) => {
  e.preventDefault()
  scrollToTarget((e.currentTarget as HTMLAnchorElement).getAttribute('href')!)
}

export default function Landing() {
  const root = useRef<HTMLDivElement>(null)
  const [splash, setSplash] = useState(!splashPlayed)
  const clock = useChainClock()
  // the clock shows the newest real announcement and the bond behind it
  const { data: ann, isError: annError } = useLatestAnnouncement()
  const chain = useChainInfo(ann?.bond.chain)
  const notice = ann ? ann.bond.noticeBlocks : null
  const start = ann ? Number(ann.blockNumber) : null
  const noticeText =
    notice === null
      ? '…'
      : (blocksToTime(notice, chain.blockS) ?? `${fmtInt(notice)} blocks`)

  useEffect(() => {
    const id = setInterval(() => {
      const b = clock.base(),
        sb = root.current?.querySelector('.splash .sb')
      if (sb && b !== null) sb.textContent = `#${fmtInt(b)}`
    }, 200)
    return () => clearInterval(id)
  }, [clock.base])

  useEffect(() => {
    const el = root.current!
    const reduce = reducedMotion()
    const { gsap, ScrollTrigger, SplitText } = registerGsap()
    const light: Light = { lx: 0.3, on: reduce ? 1 : 0 }
    const $ = (s: string) => el.querySelector(s) as HTMLElement
    const stopBeam = startBeam(
      $('.gl') as HTMLCanvasElement,
      $('.glyphs') as HTMLCanvasElement,
      light,
      reduce,
    )
    const stopFlow = startFlow(el, gsap, reduce)
    const splashEl = el.querySelector<HTMLElement>('.splash')
    const done = () => {
      splashPlayed = true
      setSplash(false)
    }
    if (reduce) {
      done()
      return () => {
        stopBeam()
        stopFlow()
      }
    }
    const life = { cancelled: false }
    const ctx = gsap.context(() => {
      gsap.to('.hero-copy', {
        yPercent: -16,
        opacity: 0.15,
        ease: 'none',
        scrollTrigger: {
          trigger: '.hero',
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
      })
      gsap.from('.dial-in', {
        scale: 0.92,
        rotate: -8,
        duration: 1.4,
        ease: 'expo.out',
        scrollTrigger: { trigger: '#clock', start: 'top 75%' },
      })
      gsap.from('.item', {
        y: 24,
        stagger: 0.1,
        duration: 0.9,
        ease: 'expo.out',
        scrollTrigger: { trigger: '.guar', start: 'top 75%' },
      })
    }, el)

    if (splashEl) {
      // a reload would otherwise restore the old scroll position under the splash and open on [01]
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
      scrollTo(0, 0)
      getLenis()?.scrollTo(0, { immediate: true, force: true })
      getLenis()?.stop()
    }

    document.fonts.ready.then(() => {
      if (life.cancelled) return
      ctx.add(() => {
        const h1 = $('.hero h1')
        const words = splitGrad(h1, 'words')
        const glint = () =>
          gsap.fromTo(
            h1,
            { '--g': '-200px' },
            {
              '--g': `${h1.getBoundingClientRect().width + 200}px`,
              duration: 1.8,
              ease: 'power2.inOut',
            },
          )
        // hero: the lamp warms up with a flicker, then the claim, then everything that supports it
        const intro = gsap.timeline({
          paused: true,
          onComplete: () => {
            glint()
            gsap.delayedCall(9, function loop() {
              glint()
              gsap.delayedCall(9, loop)
            })
          },
        })
        intro
          .to(
            light,
            {
              keyframes: {
                on: [0, 0.9, 0.25, 1, 0.55, 1],
                easeEach: 'power1.inOut',
              },
              duration: 0.9,
            },
            0,
          )
          .from(
            '.hero-copy .eyebrow',
            { opacity: 0, y: 10, duration: 0.9, ease: 'power3.out' },
            0.1,
          )
          .from(
            words,
            { yPercent: 110, duration: 1.3, ease: 'expo.out', stagger: 0.07 },
            0.2,
          )
          .from(
            '.hero-copy p',
            { opacity: 0, y: 14, duration: 1, ease: 'power3.out' },
            0.65,
          )
          .from(
            '.hero-copy .acts > *',
            {
              opacity: 0,
              y: 14,
              duration: 0.9,
              ease: 'power3.out',
              stagger: 0.08,
            },
            0.8,
          )
          .from(
            '.hud',
            { opacity: 0, duration: 1, ease: 'power2.out', stagger: 0.15 },
            1.1,
          )

        if (!splashEl) intro.play()
        else {
          intro.from(
            document.querySelector('.navpill'),
            { y: -24, opacity: 0, duration: 1.1, ease: 'expo.out' },
            0.9,
          )
          const q = (c: string) => splashEl.querySelector(c) as HTMLElement
          const p = { v: 0 },
            num = q('.count b')
          const sp = gsap.timeline({
            onComplete: () => {
              getLenis()?.start()
              done()
            },
          })
          sp.from(
            splashEl.querySelectorAll('.corner, .count .lbl'),
            {
              opacity: 0,
              y: 6,
              duration: 0.6,
              ease: 'power2.out',
              stagger: 0.08,
            },
            0,
          )
            .from(num, { yPercent: 100, duration: 0.7, ease: 'expo.out' }, 0.05)
            // the counter and the horizon fill together: the horizon is the progress bar
            .to(
              p,
              {
                v: 100,
                duration: 1.6,
                ease: 'power2.inOut',
                onUpdate: () => {
                  num.textContent = String(Math.round(p.v)).padStart(3, '0')
                },
              },
              0.2,
            )
            .to(
              q('.fill'),
              { scaleX: 1, duration: 1.6, ease: 'power2.inOut' },
              0.2,
            )
            .to(num, { yPercent: -100, duration: 0.6, ease: 'expo.in' }, 1.85)
            .to(
              splashEl.querySelectorAll('.corner, .count .lbl'),
              { opacity: 0, duration: 0.4 },
              1.9,
            )
            // the lamp warms up like a real one: it flickers before it holds
            .to(
              q('.lamp'),
              { scale: 1, duration: 0.5, ease: 'back.out(3)' },
              2.05,
            )
            .to(
              q('.lamp'),
              { keyframes: { opacity: [0, 1, 0.2, 1, 0.5, 1] }, duration: 0.6 },
              2.05,
            )
            .fromTo(
              q('.cone'),
              { rotate: 30, opacity: 0 },
              { rotate: -75, opacity: 1, duration: 1.1, ease: 'power2.inOut' },
              2.35,
            )
            .to(
              q('.top'),
              { yPercent: -100, duration: 1.15, ease: 'expo.inOut' },
              3.05,
            )
            .to(
              q('.bot'),
              { yPercent: 100, duration: 1.15, ease: 'expo.inOut' },
              3.05,
            )
            .to(
              [q('.fill'), q('.track'), q('.lamp')],
              { opacity: 0, duration: 0.5 },
              3.3,
            )
            .add(() => {
              intro.play()
            }, 3.2)
          splashEl.addEventListener('click', () => sp.progress(1))
        }

        // section headings rise line by line out of masks, keeping their gradient
        el.querySelectorAll<HTMLElement>('h2.grad').forEach((h) => {
          const lines = splitGrad(h, 'lines')
          gsap.from(lines, {
            yPercent: 115,
            duration: 1.2,
            ease: 'expo.out',
            stagger: 0.09,
            scrollTrigger: { trigger: h, start: 'top 86%' },
          })
        })
        const st = SplitText.create('#statement', {
          type: 'words',
          wordsClass: 'w',
        })
        gsap.fromTo(
          st.words,
          { opacity: 0.15 },
          {
            opacity: 1,
            stagger: 0.05,
            ease: 'none',
            scrollTrigger: {
              trigger: '#statement',
              start: 'top 80%',
              end: 'bottom 50%',
              scrub: true,
            },
          },
        )
        ScrollTrigger.refresh()
      })
    })

    return () => {
      life.cancelled = true
      ctx.revert()
      stopBeam()
      stopFlow()
      getLenis()?.start()
    }
  }, [])

  const target = start === null || notice === null ? null : start + notice

  return (
    <div ref={root}>
      {splash && (
        <div className="splash" aria-hidden="true">
          <div className="half top">
            <div className="cone" />
          </div>
          <div className="half bot" />
          <div className="track" />
          <div className="fill" />
          <div className="lamp" />
          <div className="corner c-tl">
            <b>Fair Warning</b>
            <br />
            Notice-or-pay bonds
          </div>
          <div className="corner c-tr">
            NEAR × Base
            <br />
            Read MPC
          </div>
          <div className="corner c-br">
            Base <b className="sb">…</b>
            <br />
            Click to skip
          </div>
          <div className="count">
            <span className="lbl">Reading Base</span>
            <span className="mask">
              <b>000</b>
            </span>
          </div>
        </div>
      )}

      <header className="hero" id="top">
        <canvas className="gl" aria-hidden="true" />
        <canvas className="glyphs" aria-hidden="true" />
        <div className="vignette" />
        <div className="hud tr" aria-hidden="true">
          Lamp 01 · sweep 9 s<br />
          Notice <b>{noticeText}</b> · Bond{' '}
          <b>{ann ? fmtUsdc(ann.bond.bond) : '…'}</b>
        </div>
        <div className="hero-copy">
          <div className="wrap">
            <span className="eyebrow">Notice-or-pay bonds · NEAR × Base</span>
            <h1 className="grad">
              Every admin key gets a <em className="serif">lighthouse.</em>
            </h1>
            <p>
              Promise depositors 24 hours of notice before any upgrade. Back it
              with a USDC bond on NEAR that your admin key can't reach. Break
              the promise, and the bond pays them.
            </p>
            <div className="acts">
              <Cta href="#flow" onClick={inPage} solid>
                Follow a breach
              </Cta>
              <Cta href="#clock" onClick={inPage}>
                See the notice clock
              </Cta>
            </div>
          </div>
        </div>
        <a className="hud br-c" href="#clock" onClick={inPage}>
          <span>
            Scroll to
            <br />
            follow the light
          </span>
          <span className="cue-line" />
        </a>
      </header>

      <section className="statement">
        <div className="wrap">
          <span className="eyebrow">Why</span>
          <p id="statement">
            Timelocks protect depositors until a team switches them off for
            speed. Fair Warning keeps the speed, and makes{' '}
            <em className="serif">skipping the warning</em> expensive.
          </p>
        </div>
      </section>

      <section className="clock" id="clock">
        <div className="wrap grid2">
          <div>
            <span className="br">[01]</span>
            <h2 className="grad">
              The notice clock runs on <em className="serif">Base blocks.</em>
            </h2>
            <p className="sub">
              An announced upgrade starts the clock. Base adds a block about
              every 0.2 seconds, so 24 hours of notice is 432,000 of them.
              Depositors can leave at any point before the hand comes round.
            </p>
            {annError ? (
              <p className="sub">The indexer is offline, so the clock has no announcement to show.</p>
            ) : (
              <div className="facts">
                <div>
                  <span className="eyebrow">Announced</span>
                  <b>
                    {ann ? (
                      <a href={chain.links.tx(ann.txHash)} target="_blank" rel="noreferrer">
                        block {fmtInt(start!)}
                      </a>
                    ) : ann === null ? (
                      'Nothing yet'
                    ) : (
                      '…'
                    )}
                  </b>
                </div>
                <div>
                  <span className="eyebrow">Upgrade allowed</span>
                  <b>{target === null ? '…' : `block ${fmtInt(target)}`}</b>
                </div>
                <div>
                  <span className="eyebrow">Change</span>
                  <b>{ann ? describeExpectedLog(ann.expectedLog) : '…'}</b>
                </div>
                {ann && (
                  <div>
                    <span className="eyebrow">Bond</span>
                    <b>
                      <Link to="/bonds/$slug" params={{ slug: ann.bond.slug }}>
                        {ann.bond.name}
                      </Link>
                    </b>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="dial-in">
            <NoticeDial
              block={() => clock.evm(chain.chain)}
              target={target}
              notice={notice ?? 1}
              label={`${chain.label} block`}
              blockS={chain.blockS}
              tilt
            />
          </div>
        </div>
      </section>

      <section className="flow" id="flow">
        <div className="wrap flow-in">
          <div className="flow-head">
            <div>
              <span className="br">[02]</span>
              <h2 className="grad">
                Follow the light from a silent upgrade{' '}
                <em className="serif">to the depositors.</em>
              </h2>
            </div>
            <p className="sub">
              Scroll to move one breach through the system. Every step is a real
              contract call, and the hash is the one the NEAR MPC network signs.
            </p>
          </div>
          <div className="tabs" role="tablist" aria-label="Scenario">
            <span className="tab-ind" aria-hidden="true" />
            <button
              className="tab"
              role="tab"
              type="button"
              aria-selected="true"
              data-sc="breach"
            >
              A breach
            </button>
            <button
              className="tab"
              role="tab"
              type="button"
              aria-selected="false"
              data-sc="honest"
            >
              An honest upgrade
            </button>
          </div>
          <div className="stage">
            <div className="stage-scroll">
              <FlowSvg />
            </div>
            <div className="caption">
              <span className="n" id="stepn">
                01 / 05
              </span>
              <span className="say" id="say">
                The admin key upgrades the vault. No announcement exists.
              </span>
              <span className="bars" aria-hidden="true">
                <i className="on" />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="guar" id="guar">
        <div className="wrap grid2">
          <div className="sticky">
            <span className="br">[03]</span>
            <h2 className="grad">
              What the admin key <em className="serif">can't do.</em>
            </h2>
            <p className="sub">
              Each of these is a rule in the NEAR contract, and each rule has a
              sandbox test.
            </p>
          </div>
          <div>
            {GUARANTEES.map(([h, p], i) => (
              <div className="item" key={h}>
                <div className="row">
                  <h3>{h}</h3>
                  <span className="br">[{'abcd'[i]}]</span>
                </div>
                <p>{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="close">
        <div className="wrap">
          <span className="eyebrow">For vault teams</span>
          <h2 className="grad">
            Keep your emergency speed.{' '}
            <em className="serif">Put a price on it.</em>
          </h2>
          <div className="acts">
            <Cta to="/bond/new" solid>
              Post a bond
            </Cta>
            <Cta to="/bonds">See bonded vaults</Cta>
          </div>
        </div>
      </section>
    </div>
  )
}

const GUARANTEES: Array<[string, string]> = [
  [
    'Touch the bond.',
    'It lives on NEAR. Withdrawals wait out a notice period plus Base finality, freeze while a case is open, and need a full-access key.',
  ],
  [
    'Fake an announcement.',
    'A defence counts only if the MPC network finds the real Announce log on Base, at least the promised notice before the change.',
  ],
  [
    'Reroute a payout.',
    'Depositors sign claims with the wallet they deposited from. A relayer can submit them, never redirect them, and each one pays once.',
  ],
  [
    'Punish an honest team.',
    'Announced upgrades are defended automatically, and a false reporter’s bond goes to whoever defended.',
  ],
]

const FlowSvg = () => (
  <svg
    className="sys"
    viewBox="40 66 1150 372"
    role="img"
    aria-label="A Base admin log is checked by three RPC providers and the NEAR MPC network, then the bond on NEAR pays the reporter and the depositors"
  >
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
    <path
      id="p1"
      className="path"
      d="M260 150 H330 Q350 150 350 170 V230 Q350 250 370 250 H400"
    />
    <path
      id="p0"
      className="path"
      d="M260 330 H330 Q350 330 350 310 V270 Q350 250 370 250 H400"
      strokeDasharray="3 5"
    />
    <path id="p2" className="path" d="M500 250 H600" />
    <path id="p4" className="path" d="M752 250 H820" />
    <path
      id="p3"
      className="path"
      d="M970 250 H990 Q1000 250 1000 240 V130 Q1000 120 1010 120 H1020"
    />
    <path
      id="p5"
      className="path"
      d="M970 250 H990 Q1000 250 1000 260 V370 Q1000 380 1010 380 H1020"
    />
    <g id="lits" />
    <rect className="box" x="60" y="100" width="200" height="100" rx="14" />
    <text x="78" y="128" className="t2">
      VAULT · BASE
    </text>
    <text x="78" y="158" className="big">
      Proxy upgraded
    </text>
    <circle id="flag" className="flag" cx="82" cy="180" r="4" opacity="0" />
    <text id="vsub" x="94" y="184" className="tx">
      no notice given
    </text>
    <rect
      id="annbox"
      className="box"
      x="60"
      y="280"
      width="200"
      height="100"
      rx="14"
    />
    <text x="78" y="308" className="t2">
      ANNOUNCER · BASE
    </text>
    <text id="atitle" x="78" y="338" className="big">
      No Announce
    </text>
    <text id="asub" x="78" y="362" className="t2">
      nothing to defend with
    </text>
    <g transform="translate(400 196)">
      <rect className="box" x="0" y="0" width="100" height="108" rx="12" />
      <text x="12" y="22" className="t2">
        RPC 2 / 3
      </text>
      <rect
        className="rpc"
        id="r1"
        x="12"
        y="32"
        width="76"
        height="18"
        rx="5"
      />
      <text x="20" y="45" className="tx">
        alchemy
      </text>
      <rect
        className="rpc"
        id="r2"
        x="12"
        y="56"
        width="76"
        height="18"
        rx="5"
      />
      <text x="20" y="69" className="tx">
        quicknode
      </text>
      <rect
        className="rpc"
        id="r3"
        x="12"
        y="80"
        width="76"
        height="18"
        rx="5"
      />
      <text x="20" y="93" className="tx">
        tatum
      </text>
    </g>
    <g id="ring" transform="translate(676 250)">
      <circle className="ring" r="76" />
    </g>
    <text x="676" y="246" textAnchor="middle" className="big">
      MPC
    </text>
    <text x="676" y="266" textAnchor="middle" className="t2">
      threshold 11
    </text>
    <text id="hash" x="676" y="356" textAnchor="middle" className="tx">
      payload_hash ················
    </text>
    <rect
      id="bondbox"
      className="box"
      x="820"
      y="206"
      width="150"
      height="88"
      rx="14"
    />
    <text x="836" y="230" className="t2">
      BOND · NEAR
    </text>
    <text id="bond" x="836" y="260" className="big">
      500 USDC
    </text>
    <text id="win" x="836" y="282" className="t2">
      window · 300 blocks
    </text>
    <rect className="box" x="1020" y="86" width="150" height="68" rx="14" />
    <text id="o1l" x="1036" y="108" className="t2">
      REPORTER · 10%
    </text>
    <text id="o1" x="1036" y="138" className="big">
      0 USDC
    </text>
    <rect className="box" x="1020" y="346" width="150" height="68" rx="14" />
    <text id="o3l" x="1036" y="368" className="t2">
      DEPOSITORS · 90%
    </text>
    <text id="o3" x="1036" y="398" className="big">
      0 USDC
    </text>
    <g id="orbA" opacity="0">
      <circle className="orb-halo" r="11" />
      <circle className="orb" r="4.5" />
    </g>
    <g id="orbB" opacity="0">
      <circle className="orb-halo" r="11" />
      <circle className="orb" r="4.5" />
    </g>
  </svg>
)
