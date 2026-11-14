import Lenis from 'lenis'
import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { getLenis, setLenis } from '@/lib/lenis'
import { reducedMotion, registerGsap } from '@/lib/motion'

/** One physics for every page: Lenis smooths native scroll, GSAP's ticker drives it, ScrollTrigger follows it. */
export default function LenisSmoothScrollProvider() {
  const progress = useRef<HTMLDivElement>(null)
  const { pathname, hash } = useRouterState({
    select: (s) => ({ pathname: s.location.pathname, hash: s.location.hash }),
  })

  useEffect(() => {
    const { gsap, ScrollTrigger } = registerGsap()
    const setProgress = (p: number) => {
      if (progress.current) progress.current.style.transform = `scaleX(${p})`
    }
    if (reducedMotion()) {
      const onScroll = () =>
        setProgress(
          scrollY /
            Math.max(1, document.documentElement.scrollHeight - innerHeight),
        )
      addEventListener('scroll', onScroll, { passive: true })
      return () => removeEventListener('scroll', onScroll)
    }
    const lenis = new Lenis({ lerp: 0.085, smoothWheel: true })
    setLenis(lenis)
    lenis.on('scroll', (l: Lenis) => {
      ScrollTrigger.update()
      setProgress(l.progress || 0)
    })
    const raf = (time: number) => lenis.raf(time * 1000)
    gsap.ticker.add(raf)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(raf)
      lenis.destroy()
      setLenis(null)
    }
  }, [])

  // a new page starts at its top, and its scroll-driven animations measure the new layout
  useEffect(() => {
    if (hash) return
    getLenis()?.scrollTo(0, { immediate: true, force: true })
    const { ScrollTrigger } = registerGsap()
    const t = setTimeout(() => ScrollTrigger.refresh(), 300)
    return () => clearTimeout(t)
  }, [pathname, hash])

  return (
    <>
      <div className="grain" aria-hidden="true" />
      <div className="progress" ref={progress} aria-hidden="true" />
    </>
  )
}
