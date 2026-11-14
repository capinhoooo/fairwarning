import { Link } from '@tanstack/react-router'
import type { LinkProps } from '@tanstack/react-router'
import { cnm } from '@/utils/style'

interface Common {
  children: string
  solid?: boolean
  sm?: boolean
  className?: string
}

type Props = Common &
  (
    | {
        to: LinkProps['to']
        params?: LinkProps['params']
        hash?: string
        href?: never
        onClick?: never
        type?: never
        disabled?: never
      }
    | {
        href: string
        to?: never
        onClick?: (e: React.MouseEvent) => void
        type?: never
        disabled?: never
        params?: never
        hash?: never
      }
    | {
        onClick?: () => void
        type?: 'button' | 'submit'
        disabled?: boolean
        to?: never
        href?: never
        params?: never
        hash?: never
      }
  )

/** Flat pill: hover rolls the label up and swaps the arrow; press scales to 0.97. */
export default function Cta(p: Props) {
  const cls = cnm('cta', p.solid && 'solid', p.sm && 'sm', p.className)
  const inner = (
    <>
      <span className="roll">
        <span>{p.children}</span>
      </span>
      {p.solid && (
        <i className="arw" aria-hidden="true">
          <span>→</span>
        </i>
      )}
    </>
  )
  if (p.to !== undefined)
    return (
      <Link to={p.to} params={p.params as never} hash={p.hash} className={cls}>
        {inner}
      </Link>
    )
  if (p.href !== undefined) {
    const external = /^https?:/.test(p.href)
    return (
      <a
        href={p.href}
        className={cls}
        onClick={p.onClick}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {inner}
      </a>
    )
  }
  return (
    <button
      type={p.type ?? 'button'}
      className={cls}
      onClick={p.onClick}
      disabled={p.disabled}
    >
      {inner}
    </button>
  )
}
