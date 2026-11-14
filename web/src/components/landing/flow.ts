import type { gsap as Gsap } from 'gsap'

const NS = 'http://www.w3.org/2000/svg'
const TAU = Math.PI * 2
const HASH = 'fb8f25f6b7bad4ff' // the real mainnet payload hash v1.signer signed (tools/check_mainnet_vector.ts)

type Scenario = 'breach' | 'honest'

// two stories through the same drawing: the breach, and the honest upgrade the contract must never punish
const SC = {
  breach: {
    say: [
      'The admin key upgrades the vault. No announcement exists.',
      'Three Base RPC providers fetch the receipt. Two must agree.',
      'The NEAR MPC network signs exactly what Base returned.',
      'The bond contract opens a case. No one proves notice in 300 blocks.',
      'The bond pays: 50 USDC to the reporter, 450 to depositors.',
    ],
    vsub: 'no notice given',
    flag: 'flag',
    atitle: 'No Announce',
    asub: 'nothing to defend with',
    o1l: 'REPORTER · 10%',
    o3l: 'DEPOSITORS · 90%',
  },
  honest: {
    say: [
      'The admin key announced this upgrade 432,000 blocks ago, then made it.',
      'A reporter claims a breach anyway. Base RPC providers fetch the receipt.',
      'The NEAR MPC network signs the upgrade log. A case opens.',
      'A defender proves the Announce log, early enough. The MPC signs that too.',
      'Defended. The bond stays whole; the false reporter’s 0.5 NEAR goes to the defender.',
    ],
    vsub: 'notice given 24 h ago',
    flag: 'flag ok',
    atitle: 'Announce',
    asub: '432,000 blocks earlier',
    o1l: 'REPORTER · BOND',
    o3l: 'DEPOSITORS',
  },
}

/** The pinned [02] diagram: one breach (or one honest upgrade) travels the system as you scroll. Returns a cleanup. */
export const startFlow = (
  root: HTMLElement,
  gsap: typeof Gsap,
  reduce: boolean,
) => {
  const $ = <T extends Element = HTMLElement>(id: string) =>
    root.querySelector(`#${id}`) as T
  const text = (id: string, s: string) => ($(id).textContent = s)
  const cleanups: Array<() => void> = []

  const ring = $<SVGGElement>('ring')
  ring.querySelectorAll('.node').forEach((n) => n.remove())
  const nodes: Array<SVGCircleElement> = []
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU - Math.PI / 2,
      n = document.createElementNS(NS, 'circle')
    n.setAttribute('class', 'node')
    n.setAttribute('r', '5')
    n.setAttribute('cx', String(Math.cos(a) * 76))
    n.setAttribute('cy', String(Math.sin(a) * 76))
    ring.appendChild(n)
    nodes.push(n)
  }
  const litsG = $<SVGGElement>('lits')
  litsG.textContent = ''
  const lits: Record<string, { el: SVGPathElement; len: number }> = {}
  ;['p1', 'p0', 'p2', 'p4', 'p3', 'p5'].forEach((id) => {
    const src = $<SVGPathElement>(id),
      p = src.cloneNode() as SVGPathElement
    p.removeAttribute('id')
    p.removeAttribute('stroke-dasharray')
    p.setAttribute('class', 'lit')
    const len = src.getTotalLength()
    p.style.strokeDasharray = String(len)
    p.style.strokeDashoffset = String(len)
    litsG.appendChild(p)
    lits[id] = { el: p, len }
  })
  cleanups.push(() => {
    litsG.textContent = ''
    nodes.forEach((n) => n.remove())
  })

  let scName: Scenario = 'breach'
  const bars = root.querySelectorAll('.caption .bars i')
  let shown = -1
  const setStep = (k: number, animate?: boolean) => {
    if (k === shown) return
    shown = k
    text('stepn', `0${k + 1} / 05`)
    text('say', SC[scName].say[k])
    bars.forEach((b, i) => b.classList.toggle('on', i <= k))
    if (animate)
      gsap.fromTo(
        $('say'),
        { opacity: 0, y: 6 },
        {
          opacity: 1,
          y: 0,
          duration: 0.35,
          ease: 'power2.out',
          overwrite: true,
        },
      )
    // phones: the drawing is wider than the screen, so the frame pans to keep the current step in view
    const sc = root.querySelector('.stage-scroll') as HTMLElement
    if (animate && sc.scrollWidth > sc.clientWidth + 4) {
      const cx =
        scName === 'honest' && k === 3 ? 160 : [160, 450, 676, 895, 1095][k]
      const x = ((cx - 40) / 1150) * sc.scrollWidth - sc.clientWidth / 2
      gsap.to(sc, {
        scrollLeft: Math.max(0, x),
        duration: 0.8,
        ease: 'power2.inOut',
        overwrite: true,
      })
    }
  }
  const applyLabels = () => {
    const s = SC[scName]
    text('vsub', s.vsub)
    $('flag').setAttribute('class', s.flag)
    text('atitle', s.atitle)
    text('asub', s.asub)
    text('o1l', s.o1l)
    text('o3l', s.o3l)
    $('annbox').setAttribute('class', scName === 'honest' ? 'box hot' : 'box')
  }
  const hashAt = (p: number) => {
    const k = Math.floor(HASH.length * p)
    return (
      'payload_hash ' +
      HASH.slice(0, k) +
      '·'.repeat(HASH.length - k) +
      (p >= 1 ? '…' : '')
    )
  }
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('.tab')]
  const select = (btn: HTMLButtonElement) =>
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b === btn)))

  const finished = () => {
    applyLabels()
    ;['p1', 'p2', 'p4', 'p3', 'p5'].forEach(
      (id) => (lits[id].el.style.strokeDashoffset = '0'),
    )
    $('r1').setAttribute('class', 'rpc ok')
    $('r2').setAttribute('class', 'rpc ok')
    $('r3').setAttribute('class', 'rpc wait')
    nodes.forEach((n) => n.classList.add('on'))
    $('flag').setAttribute('opacity', '1')
    text('hash', hashAt(1))
    text('win', 'window · closed')
    text('o1', '50 USDC')
    text('o3', '450 USDC')
    text('bond', '0 USDC')
    setStep(4)
  }
  if (reduce) {
    // without motion the tabs still switch the story, shown in its finished state
    finished()
    const handlers = tabs.map((t) => {
      const h = () => {
        scName = t.dataset.sc as Scenario
        shown = -1
        select(t)
        finished()
        if (scName === 'honest') {
          lits.p3.el.style.strokeDashoffset = String(lits.p3.len)
          lits.p5.el.style.strokeDashoffset = String(lits.p5.len)
          lits.p0.el.style.strokeDashoffset = '0'
          text('o1', '−0.5 NEAR')
          text('o3', 'safe')
          text('bond', '500 USDC')
          text('win', 'window · defended')
        } else lits.p0.el.style.strokeDashoffset = String(lits.p0.len)
      }
      t.addEventListener('click', h)
      return () => t.removeEventListener('click', h)
    })
    return () => [...handlers, ...cleanups].forEach((f) => f())
  }

  // each path gets the orb it owns, so two orbs never fight over one element
  const orbA = $('orbA'),
    orbB = $('orbB')
  const travel = (orb: Element, id: string, dur: number) =>
    gsap
      .timeline()
      .set(orb, { opacity: 1 })
      .to(
        orb,
        {
          duration: dur,
          ease: 'none',
          motionPath: { path: $(id) as unknown as SVGPathElement },
        },
        0,
      )
      .to(lits[id].el, { strokeDashoffset: 0, duration: dur, ease: 'none' }, 0)
      .to(orb, { opacity: 0, duration: 0.12 })
  const build = (name: Scenario) => {
    const t = gsap.timeline({ paused: true, defaults: { ease: 'none' } })
    t.addLabel('s0', 0)
      .to({}, { duration: 0.3 })
      .add(travel(orbA, 'p1', 1.1))
      .addLabel('s1')
      .to({}, { duration: 0.8 })
      .add(travel(orbA, 'p2', 0.6))
      .addLabel('s2')
      .to({}, { duration: 0.9 })
      .add(travel(orbA, 'p4', 0.5))
      .addLabel('s3')
    if (name === 'breach') {
      t.to({}, { duration: 1 })
        .addLabel('s4')
        .add(travel(orbA, 'p3', 0.7))
        .add(travel(orbB, 'p5', 0.7), '<')
        .to({}, { duration: 1.1 })
    } else {
      t.add(travel(orbB, 'p0', 0.9))
        .to({}, { duration: 0.3 })
        .addLabel('s4')
        .to({}, { duration: 1.5 })
    }
    return t
  }
  // every visible value derives from the playhead, so a fast scrub in either direction never leaves a stale number
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
  let tl: ReturnType<typeof Gsap.timeline> | null = null
  const sync = () => {
    const t = tl!.time(),
      L = tl!.labels,
      honest = scName === 'honest'
    setStep(
      t >= L.s4 ? 4 : t >= L.s3 ? 3 : t >= L.s2 ? 2 : t >= L.s1 ? 1 : 0,
      true,
    )
    $('flag').setAttribute('opacity', String(clamp01(t / 0.3)))
    text('hash', hashAt(clamp01((t - L.s2) / 0.9)))
    $('bondbox').setAttribute('class', t >= L.s3 ? 'box hot' : 'box')
    const w = Math.round(
      300 * (1 - clamp01((t - L.s3) / 1) * (honest ? 0.3 : 1)),
    )
    text(
      'win',
      honest && t >= L.s4
        ? 'window · defended'
        : w > 0
          ? `window · ${w} blocks`
          : 'window · closed',
    )
    if (honest) {
      text('o1', t >= L.s4 ? '−0.5 NEAR' : '0.5 NEAR')
      text('o3', t >= L.s4 ? 'safe' : '—')
      text('bond', '500 USDC')
    } else {
      const pay = clamp01((t - L.s4) / 0.7)
      text('o1', `${Math.round(50 * pay)} USDC`)
      text('o3', `${Math.round(450 * pay)} USDC`)
      text('bond', `${Math.round(500 - 500 * pay)} USDC`)
    }
    $('r1').setAttribute('class', t >= L.s1 + 0.15 ? 'rpc ok' : 'rpc')
    $('r2').setAttribute('class', t >= L.s1 + 0.4 ? 'rpc ok' : 'rpc')
    $('r3').setAttribute('class', t >= L.s1 + 0.6 ? 'rpc wait' : 'rpc')
    nodes.forEach((n, i) =>
      n.classList.toggle(
        'on',
        t >= L.s2 + i * 0.05 || (honest && t >= L.s3 + 0.9 - i * 0.02),
      ),
    )
  }
  // one scroll-driven proxy feeds whichever story is selected, so switching tabs never disturbs the pinned scroll
  const drive = { p: 0 }
  const show = () => {
    tl!.progress(drive.p)
    sync()
  }
  const choose = (name: Scenario) => {
    tl?.kill()
    Object.values(lits).forEach(
      (l) => (l.el.style.strokeDashoffset = String(l.len)),
    )
    gsap.set([orbA, orbB], { opacity: 0 })
    scName = name
    shown = -1
    applyLabels()
    tl = build(name)
    show()
  }
  choose('breach')

  const ind = root.querySelector('.tab-ind') as HTMLElement
  const moveInd = (btn: HTMLElement, instant?: boolean) =>
    gsap.to(ind, {
      x: btn.offsetLeft - 4,
      width: btn.offsetWidth,
      duration: instant ? 0 : 0.5,
      ease: 'expo.out',
    })
  document.fonts.ready.then(() => moveInd(tabs[0], true))
  let mobilePlay: ReturnType<typeof Gsap.fromTo> | null = null
  const handlers = tabs.map((btn) => {
    const h = () => {
      if (btn.dataset.sc === scName) return
      select(btn)
      moveInd(btn)
      choose(btn.dataset.sc as Scenario)
      mobilePlay?.restart()
    }
    btn.addEventListener('click', h)
    return () => btn.removeEventListener('click', h)
  })

  const mm = gsap.matchMedia()
  const flow = $('flow')
  mm.add('(min-width: 861px)', () => {
    gsap.to(drive, {
      p: 1,
      ease: 'none',
      onUpdate: show,
      scrollTrigger: {
        trigger: flow,
        start: 'top top',
        end: '+=1800',
        pin: true,
        scrub: 0.6,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    })
    // the panel grows into place as the section arrives, like Aave's and Zama's inset panels
    gsap.fromTo(
      root.querySelector('.stage'),
      { scale: 0.93, borderRadius: 40 },
      {
        scale: 1,
        borderRadius: 24,
        ease: 'none',
        scrollTrigger: {
          trigger: flow,
          start: 'top 85%',
          end: 'top top',
          scrub: true,
        },
      },
    )
  })
  mm.add('(max-width: 860px)', () => {
    gsap.timeline({
      scrollTrigger: {
        trigger: flow,
        start: 'top 70%',
        once: true,
        onEnter: () => {
          mobilePlay = gsap.fromTo(
            drive,
            { p: 0 },
            { p: 1, duration: 6, ease: 'none', onUpdate: show },
          )
        },
      },
    })
  })
  return () => {
    mm.revert()
    tl?.kill()
    mobilePlay?.kill()
    ;[...handlers, ...cleanups].forEach((f) => f())
  }
}
