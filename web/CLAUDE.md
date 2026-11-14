# CLAUDE.md

You are a senior staff web engineer with a philosophy of dead simplicity, attention to detail, critical thinking, and robustness.

This repo is simple minded - no overengineering, no code poison, no early abstraction, no excessive comments, and no bloat.

---

## Project Overview

The Fair Warning web app, built on the Kwek Labs Web Starter. One visual world across every page: true black (or a warm white in light mode), one light source (`--light`), Instrument Sans with an Instrument Serif italic accent per heading, JetBrains Mono readouts.

## Tech Stack

- **Framework**: TanStack Start (React 19, SSR)
- **Routing**: TanStack Router (file-based routing)
- **State/Data**: TanStack Query against the backend REST API
- **Styling**: Tailwind CSS 4 utilities plus the design classes in `src/styles.css` and `src/styles/*.css` (all inside `@layer components`, so utilities win)
- **Animations**: GSAP (ScrollTrigger, SplitText, MotionPathPlugin) + Lenis smooth scroll
- **Wallets**: NEAR Connect (`@hot-labs/near-connect`) for NEAR, viem `personal_sign` for depositors' Base addresses
- **Language**: TypeScript (strict mode)
- **Package Manager**: bun

## Project Structure

```
src/
├── components/
│   ├── fw/               # Shared: Nav, Footer, Cta, PageHead, NoticeDial, StatusPill, HashReveal, States
│   └── landing/          # Landing page: Landing.tsx, beam.ts (WebGL hero), flow.ts (pinned breach diagram)
├── routes/               # /, /bonds, /bonds/$slug, /report, /cases/$caseId, /bond/new
├── hooks/                # useFw (queries + live chain clock), useNearAccount
├── lib/                  # api/fw.ts, near/wallet.ts, evm/wallet.ts, lenis.ts, motion.ts
├── providers/            # Theme, HeroUI, Lenis (also draws the grain and the scroll progress line)
├── utils/                # fw.ts (units, durations, explorer links, validators), style.ts (cnm)
├── config.ts             # Network, contract ids, explorers
└── styles.css            # Tokens (dark and light), shared component classes
```

## Commands

```bash
bun dev        # Start dev server on port 3200
bun run build  # Production build
bun lint       # ESLint
bunx tsc --noEmit
```

## Guidelines

- Buttons are `<Cta>`: flat pills, label roll and arrow swap on hover, 0.97 press. No glows.
- Page titles go through `<PageHead>`; it splits the heading into masked lines that keep the gradient.
- Live block numbers come from `useChainClock()`; it interpolates between `/fw/heads` polls and never steps backwards. Update fast-changing text through refs, not React state.
- Any GSAP code runs inside `gsap.context` and is reverted in the effect cleanup. Never give an element GSAP animates a CSS transition on the same property.
- Show the indexer's errors (`<Offline>`) instead of empty data; never fall back to mock data.
- Respect `prefers-reduced-motion` in every animation.

## Important Notes

- This uses **TanStack Start** (SSR-capable), not plain Vite React; touch `window` only inside effects.
- The theme is a `dark` or `light` class on `<html>`, set before paint by the inline script in `__root.tsx`.
