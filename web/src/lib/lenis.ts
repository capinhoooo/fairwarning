import type Lenis from 'lenis'

// the one Lenis instance, created by LenisSmoothScrollProvider; pages stop it under the splash and scroll with it
let instance: Lenis | null = null

export const setLenis = (lenis: Lenis | null) => {
  instance = lenis
}

export const getLenis = () => instance

export const scrollToTarget = (target: string | HTMLElement | number) => {
  if (instance) instance.scrollTo(target, { duration: 1.6 })
  else if (typeof target === 'number') window.scrollTo({ top: target })
  else
    (typeof target === 'string'
      ? document.querySelector(target)
      : target
    )?.scrollIntoView()
}
