import { useEffect, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import Cta from '@/components/fw/Cta'
import { useChainClock, useStats } from '@/hooks/useFw'
import { useNearAccount } from '@/hooks/useNearAccount'
import { scrollToTarget } from '@/lib/lenis'
import { useTheme } from '@/providers/ThemeProvider'
import { fmtInt, fmtUsdc, short } from '@/utils/fw'

/** The brand mark, painted through a mask so its color follows the theme's --mark token. */
export const LogoMark = ({ className = '' }: { className?: string }) => (
  <span className={`logo-mark ${className}`} aria-hidden="true" />
)

/** "How it works" lives on the landing page; from there it scrolls, from elsewhere it navigates. */
const useHowItWorks = () => {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (e: React.MouseEvent) => {
    if (path !== '/') return
    e.preventDefault()
    scrollToTarget('#flow')
  }
}

export default function Nav() {
  const { toggleTheme } = useTheme()
  const { accountId, connect, disconnect } = useNearAccount()
  const stats = useStats()
  const clock = useChainClock()
  const blockChip = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const how = useHowItWorks()
  const path = useRouterState({ select: (s) => s.location.pathname })

  useEffect(() => setOpen(false), [path])

  // the block chip counts with Base without re-rendering the nav every 200 ms
  useEffect(() => {
    const id = setInterval(() => {
      const b = clock.base()
      if (blockChip.current)
        blockChip.current.textContent =
          b === null ? 'Base …' : `Base #${fmtInt(b)}`
    }, 200)
    return () => clearInterval(id)
  }, [clock.base])

  const bonded = stats.data
    ? fmtUsdc(stats.data.bonded).replace(/\.\d+ /, ' ')
    : null

  return (
    <div className="navbar">
      <nav className="navpill relative" aria-label="Main">
        <Link to="/" className="logo">
          <LogoMark />
          Fair Warning
        </Link>
        <Link to="/bonds" className="lnk">
          Bonds
        </Link>
        <Link to="/report" className="lnk">
          Report
        </Link>
        <Link
          to="/"
          hash="flow"
          className="lnk"
          onClick={how}
          activeOptions={{ exact: true, includeHash: true }}
        >
          How it works
        </Link>
        <span className="chips">
          <Link
            to="/bonds"
            className="chipx"
            title="USDC bonded on NEAR across live commitments"
          >
            <i className={stats.data?.covered ? '' : 'off'} />
            {bonded ? `${bonded} bonded` : 'Bonds …'}
          </Link>
          <span className="chipx hide-sm mono" ref={blockChip}>
            Base …
          </span>
        </span>
        <button
          className="ghost wide ml-auto-sm"
          type="button"
          onClick={() => (accountId ? disconnect() : connect())}
          title={accountId ? 'Disconnect NEAR wallet' : 'Connect a NEAR wallet'}
        >
          {accountId ? short(accountId, 10, 6) : 'Connect'}
        </button>
        <button
          className="ghost"
          type="button"
          onClick={toggleTheme}
          aria-label="Switch between light and dark"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
          </svg>
        </button>
        <button
          className="ghost menu-btn"
          type="button"
          aria-expanded={open}
          aria-label="Menu"
          onClick={() => setOpen((o) => !o)}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden="true"
          >
            {open ? (
              <path d="M4 4l8 8M12 4l-8 8" />
            ) : (
              <path d="M2.5 5.5h11M2.5 10.5h11" />
            )}
          </svg>
        </button>
        <Cta to="/bond/new" solid sm>
          Post a bond
        </Cta>
        {open && (
          <div className="menu">
            <Link to="/bonds">Bonds</Link>
            <Link to="/report">Report a breach</Link>
            <Link to="/bond/new">Post a bond</Link>
            <Link to="/" hash="flow" onClick={how}>
              How it works
            </Link>
          </div>
        )}
      </nav>
    </div>
  )
}
