import { useLayoutEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import type {
  CaseDetail,
  CaseStatus,
  ClaimQuote,
  ClaimRoute,
  Payout,
} from '@/lib/api/fw'
import Cta from '@/components/fw/Cta'
import PageHead from '@/components/fw/PageHead'
import { Offline, Skeleton } from '@/components/fw/States'
import { CaseStatusPill } from '@/components/fw/StatusPill'
import {
  useCase,
  useChainClock,
  useChainInfo,
  useNow,
  usePayout,
  useQuoteClaim,
  useSubmitClaim,
} from '@/hooks/useFw'
import { requestEvmAddress, signWithEvm } from '@/lib/evm/wallet'
import {
  account,
  chainLabel,
  fmtInt,
  fmtUsdc,
  hex0x,
  isEvmAddress,
  isNearAccount,
  isSolAddress,
  links,
  nearBlocksToTime,
  short,
} from '@/utils/fw'

export const Route = createFileRoute('/cases/$caseId')({
  head: ({ params }) => ({
    meta: [{ title: `Case #${params.caseId} · Fair Warning` }],
  }),
  component: CasePage,
})

const ext = { target: '_blank', rel: 'noopener noreferrer' }

const TITLES: Record<CaseStatus, [string, string]> = {
  Reported: ['Waiting for the', 'MPC network.'],
  DefenceOpen: ['The defence window', 'is open.'],
  Defended: ['Defended.', 'The bond stays.'],
  Breached: ['Breach confirmed.', 'The bond pays.'],
  Paid: ['Paid out', 'in full.'],
  Rejected: ['Report', 'rejected.'],
  Moot: ['Case', 'closed as moot.'],
}

const SUBS: Record<CaseStatus, string> = {
  Reported:
    'The contract asked the NEAR MPC network to read this log from its chain. Its signature, over the exact hash, decides whether the case opens.',
  DefenceOpen:
    'The MPC network confirmed the log. The team can now prove an Announce log made early enough. If no one does before the window closes, the bond pays.',
  Defended:
    'An Announce log made early enough was proven on chain. Nothing is paid, and the reporter’s bond went to whoever defended.',
  Breached:
    'No notice was proven in time. The reporter’s share is paid, and depositors can claim theirs with the wallet they deposited from.',
  Paid: 'Every share of this case has been paid.',
  Rejected:
    'The MPC network did not confirm the log, or the report expired. The bond was never touched.',
  Moot: 'This bond had already paid out on another case, so this one closed and the reporter’s bond was refunded.',
}

const EMPTY_PAYOUTS: Record<CaseStatus, string> = {
  Reported: 'Nothing is owed until the MPC network confirms the log.',
  DefenceOpen: 'Nothing is owed while the defence window is open.',
  Defended: 'Nothing is owed. The change was announced in time.',
  Breached: 'No payout queued yet.',
  Paid: 'No payout recorded here.',
  Rejected: 'Nothing is owed. The report did not hold.',
  Moot: 'Nothing is owed on this case.',
}

const AT: Record<CaseStatus, number> = {
  Reported: 1,
  DefenceOpen: 2,
  Defended: 3,
  Moot: 3,
  Breached: 4,
  Paid: 4,
  Rejected: 1,
}
const TERMINAL: Partial<Record<CaseStatus, string>> = {
  Paid: 'done',
  Defended: 'done',
  Moot: 'done',
  Rejected: 'bad',
}

/** Station states for the five-step track; the light fills up to the current station and a spark runs toward the next. */
const stations = (s: CaseStatus, chain: string) => {
  const at = AT[s]
  return [
    ['Admin log', `on ${chain}`],
    [`MPC reads ${chain}`, s === 'Rejected' ? 'not confirmed' : 'Read MPC'],
    ['Defence window', 'NEAR blocks'],
    [
      s === 'Defended' ? 'Defended' : s === 'Moot' ? 'Moot' : 'Breach',
      'verdict',
    ],
    [
      'Payout',
      s === 'Defended' || s === 'Moot'
        ? 'nothing owed'
        : 'reporter · depositors',
    ],
  ].map(([b, sub], i) => ({
    b,
    sub,
    state: i < at ? 'done' : i === at ? (TERMINAL[s] ?? 'now') : '',
  }))
}

function Track({ status, chain }: { status: CaseStatus; chain: string }) {
  const st = stations(status, chain)
  const at = AT[status]
  const root = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState({ left: 0, width: 0, run: 0, full: 0 })
  // the fill reaches the current station's centre; the spark runs from there to the next one
  useLayoutEffect(() => {
    const el = root.current!
    const measure = () => {
      const dots = el.querySelectorAll<HTMLElement>('.dot'),
        r = el.getBoundingClientRect()
      const cx = (i: number) => {
        const d = dots[Math.min(i, dots.length - 1)].getBoundingClientRect()
        return d.left + d.width / 2 - r.left
      }
      setGeo({
        left: cx(0),
        width: cx(at) - cx(0),
        run: at < 4 ? cx(at + 1) - cx(at) : 0,
        full: cx(4) - cx(0),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [at])
  const live = st.some((x) => x.state === 'now')
  return (
    <div className="ctrack" ref={root} aria-label={`Case progress: ${status}`}>
      <span
        className="line"
        style={{ left: geo.left, right: 'auto', width: geo.full }}
      />
      <span className="fill" style={{ left: geo.left, width: geo.width }} />
      {live && geo.run > 0 && (
        <span
          className="spark"
          style={{
            left: geo.left + geo.width,
            ['--run' as string]: `${geo.run}px`,
          }}
        />
      )}
      {st.map((x) => (
        <div key={x.b} className={`st ${x.state}`}>
          <span className="dot" />
          <b>{x.b}</b>
          <span>{x.sub}</span>
        </div>
      ))}
    </div>
  )
}

const ROUTES: Array<{
  id: ClaimRoute
  label: string
  placeholder: string
  valid: (s: string) => boolean
}> = [
  {
    id: 'near',
    label: 'NEAR account',
    placeholder: 'you.near',
    valid: isNearAccount,
  },
  {
    id: 'base',
    label: 'USDC on Base',
    placeholder: '0x… Base address',
    valid: isEvmAddress,
  },
  {
    id: 'sol',
    label: 'USDC on Solana',
    placeholder: 'Solana address',
    valid: isSolAddress,
  },
]

function PayoutTrack({ id }: { id: string }) {
  const q = usePayout(id)
  const p = q.data
  if (!p) return <Skeleton rows={1} />
  const steps: Array<[Payout['status'], string]> = [
    ['queued', 'Queued for the relayer'],
    ['submitted', 'fw.claim submitted on NEAR'],
    ['paid', 'USDC sent'],
    ...(p.route === '1click'
      ? [['bridged', 'Delivered by NEAR Intents'] as [Payout['status'], string]]
      : []),
  ]
  const idx = steps.findIndex(([s]) => s === p.status)
  return (
    <ol className="rail">
      {steps.map(([s, label], i) => (
        <li
          key={s}
          className={
            p.status === 'failed' && i === Math.max(idx, 1)
              ? 'bad'
              : i < idx || (i === idx && i === steps.length - 1)
                ? 'ok'
                : i === idx
                  ? 'lit'
                  : 'todo'
          }
        >
          <h4>{label}</h4>
          {s === 'submitted' && p.nearTxHash && (
            <div className="meta">
              <a className="lnk-u" href={links.nearTx(p.nearTxHash)} {...ext}>
                {short(p.nearTxHash, 10, 8)}
              </a>
            </div>
          )}
          {s === 'bridged' && (
            <div className="meta">
              <a className="lnk-u" href={links.intents(p.payTo)} {...ext}>
                Track on the Intents explorer
              </a>
              {p.oneClickStatus ? ` · ${p.oneClickStatus}` : ''}
            </div>
          )}
        </li>
      ))}
      {p.status === 'failed' && p.error && <p className="err">{p.error}</p>}
    </ol>
  )
}

function Claim({ caseId }: { caseId: number }) {
  const [route, setRoute] = useState<ClaimRoute>('near')
  const [recipient, setRecipient] = useState('')
  const [address, setAddress] = useState<`0x${string}` | null>(null)
  const [quote, setQuote] = useState<ClaimQuote | null>(null)
  const [payoutId, setPayoutId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const quoteM = useQuoteClaim()
  const submitM = useSubmitClaim()
  const r = ROUTES.find((x) => x.id === route)!
  const valid = r.valid(recipient)

  const check = async () => {
    setError(null)
    try {
      const a = address ?? (await requestEvmAddress())
      setAddress(a)
      setQuote(
        await quoteM.mutateAsync({
          caseId,
          baseAddress: a,
          route,
          recipient: recipient.trim(),
        }),
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const sign = async () => {
    if (!quote || !address || !quote.payTo || !quote.message) return
    setError(null)
    try {
      const signature = await signWithEvm(address, quote.message)
      const res = await submitM.mutateAsync({
        caseId,
        baseAddress: address,
        payTo: quote.payTo,
        route,
        signature,
        destinationAddress: route === 'near' ? undefined : recipient.trim(),
      })
      setPayoutId(res.payoutId)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (payoutId)
    return (
      <div className="panel grid gap-5">
        <span className="eyebrow">Your claim</span>
        <PayoutTrack id={payoutId} />
      </div>
    )

  return (
    <div className="panel grid gap-6">
      <div>
        <span className="eyebrow">Deposited in this vault?</span>
        <h3 className="mt-3 text-[26px] leading-tight font-medium tracking-[-0.03em]">
          Claim your share. <em className="serif">No gas, no bridge.</em>
        </h3>
        <p className="mt-3 text-fg-2">
          Prove the address you deposited from with a signature. A relayer
          submits it; it can't change where the money goes.
        </p>
      </div>
      <div className="seg" role="group" aria-label="Where to receive">
        {ROUTES.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={route === x.id}
            onClick={() => {
              setRoute(x.id)
              setQuote(null)
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <label className="label">
        <span>Send to</span>
        <input
          className="field"
          value={recipient}
          onChange={(e) => {
            setRecipient(e.target.value)
            setQuote(null)
          }}
          placeholder={r.placeholder}
          aria-invalid={recipient !== '' && !valid}
          spellCheck={false}
          autoComplete="off"
        />
        {route !== 'near' && (
          <span className="hint">
            Paid as USDC on NEAR, then delivered by NEAR Intents 1Click.
          </span>
        )}
      </label>
      {quote && (
        <div className="kv">
          <div>
            <span className="eyebrow">Depositor</span>
            <span>{short(address, 8, 6)}</span>
          </div>
          <div>
            <span className="eyebrow">Your deposit at snapshot</span>
            <span>{fmtUsdc(quote.amount)}</span>
          </div>
          <div>
            <span className="eyebrow">Your share</span>
            <span className="text-light">{fmtUsdc(quote.share)}</span>
          </div>
          {quote.quote && (
            <div>
              <span className="eyebrow">
                {quote.dryRun ? 'On mainnet, arrives as' : 'Arrives as'}
              </span>
              <span>
                {fmtUsdc(quote.quote.amountOut)} · ~{quote.quote.timeEstimate} s
              </span>
            </div>
          )}
          {quote.payTo && (
            <div>
              <span className="eyebrow">Paid to</span>
              <span>{short(quote.payTo, 12, 8)}</span>
            </div>
          )}
        </div>
      )}
      {quote?.dryRun && (
        <p className="hint">
          Dry run. NEAR Intents has no testnet, so this is a live 1Click quote
          for your share on mainnet; nothing is signed or sent. Claim to a NEAR
          account to receive it here.
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        {!quote ? (
          <Cta solid onClick={check} disabled={!valid || quoteM.isPending}>
            {quoteM.isPending
              ? 'Checking'
              : address
                ? 'Check my share'
                : 'Connect wallet'}
          </Cta>
        ) : quote.dryRun ? (
          <Cta
            onClick={() => {
              setRoute('near')
              setRecipient('')
              setQuote(null)
            }}
          >
            Claim to a NEAR account
          </Cta>
        ) : (
          <Cta solid onClick={sign} disabled={submitM.isPending}>
            {submitM.isPending
              ? 'Submitting'
              : `Sign as ${short(address, 6, 4)}`}
          </Cta>
        )}
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  )
}

function Facts({ c }: { c: CaseDetail }) {
  const clock = useChainClock()
  const info = useChainInfo(c.protocol?.chain)
  useNow(1000)
  const chain = c.chain
  const near = clock.near()
  const deadline = chain?.deadline ?? (c.deadline ? Number(c.deadline) : null)
  const left = deadline && near ? deadline - near : null
  const status = chain?.status ?? c.status
  return (
    <div className="kv">
      {c.protocol && (
        <div>
          <span className="eyebrow">Vault</span>
          <Link to="/bonds/$slug" params={{ slug: c.protocol.slug }}>
            {c.protocol.name}
          </Link>
        </div>
      )}
      <div>
        <span className="eyebrow">{info.label} tx · log</span>
        <a href={info.links.tx(hex0x(chain?.tx_hash ?? c.txHash))} {...ext}>
          {short(hex0x(chain?.tx_hash ?? c.txHash), 10, 6)} ·{' '}
          {chain?.log_index ?? c.logIndex}
        </a>
      </div>
      <div>
        <span className="eyebrow">Change block</span>
        <span>
          {chain
            ? fmtInt(chain.breach_block)
            : c.breachBlock
              ? fmtInt(c.breachBlock)
              : '—'}
        </span>
      </div>
      <div>
        <span className="eyebrow">Reporter</span>
        <a
          href={links.nearAccount(chain?.reporter ?? c.reporter ?? '')}
          {...ext}
        >
          {account(chain?.reporter ?? c.reporter)}
        </a>
      </div>
      {status === 'DefenceOpen' && left !== null && (
        <div>
          <span className="eyebrow">Window closes</span>
          <span className="text-light">
            {left > 0
              ? `${fmtInt(left)} blocks · ${nearBlocksToTime(left)}`
              : 'closing now'}
          </span>
        </div>
      )}
      {(chain?.pending_defences ?? c.pendingDefences ?? 0) > 0 && (
        <div>
          <span className="eyebrow">Defences in flight</span>
          <span>{chain?.pending_defences ?? c.pendingDefences}</span>
        </div>
      )}
      <div>
        <span className="eyebrow">Reporter reward</span>
        <span>
          {fmtUsdc(chain?.reward ?? c.reward)}
          {chain?.reward_paid ? ' · paid' : ''}
        </span>
      </div>
      <div>
        <span className="eyebrow">Depositor pool</span>
        <span>{fmtUsdc(chain?.pool ?? c.pool)}</span>
      </div>
      {chain && (
        <div>
          <span className="eyebrow">Claimed so far</span>
          <span>
            {/* the contract's `paid` also counts the reporter reward */}
            {fmtUsdc(
              BigInt(chain.paid) -
                (chain.reward_paid ? BigInt(chain.reward) : 0n),
            )}{' '}
            · {chain.claims} {chain.claims === 1 ? 'claim' : 'claims'}
          </span>
        </div>
      )}
      {c.defenceTxHash && (
        <div>
          <span className="eyebrow">Defence</span>
          <a href={links.nearTx(c.defenceTxHash)} {...ext}>
            {short(c.defenceTxHash, 10, 6)}
          </a>
        </div>
      )}
    </div>
  )
}

function CasePage() {
  const { caseId } = Route.useParams()
  const id = /^\d+$/.test(caseId) ? Number(caseId) : null
  const q = useCase(id)
  const c = q.data

  if (id === null || q.error)
    return (
      <div className="page wrap pb-32">
        <PageHead
          index="[C]"
          eyebrow={`Case ${caseId}`}
          title={
            <>
              No case <em className="serif">by that number.</em>
            </>
          }
        />
        {q.error && <Offline error={q.error} retry={() => q.refetch()} />}
        <div className="mt-8">
          <Cta to="/bonds">All bonded vaults</Cta>
        </div>
      </div>
    )
  if (!c)
    return (
      <div className="page wrap pb-32">
        <Skeleton rows={6} />
      </div>
    )

  const status = c.chain?.status ?? c.status ?? 'Reported'
  const [t1, t2] = TITLES[status]
  const payouts = c.payouts ?? []

  return (
    <div className="page wrap pb-32">
      <PageHead
        index="[C]"
        eyebrow={`Case #${caseId}`}
        titleKey={status}
        title={
          <>
            {t1} <em className="serif">{t2}</em>
          </>
        }
        sub={SUBS[status]}
        hud={<CaseStatusPill status={status} />}
      />
      <Track status={status} chain={chainLabel(c.protocol?.chain)} />

      <div className="split mt-16">
        <div>
          <Facts c={c} />
          <div className="shead">
            <div>
              <span className="br">[01]</span>
              <h2>Payouts</h2>
            </div>
          </div>
          <div className="ledger" role="list">
            {payouts.length === 0 && (
              <p className="empty-note">
                {EMPTY_PAYOUTS[status]}
              </p>
            )}
            {payouts.map((p) => (
              <div key={p.id} className="lrow lrow-cases" role="listitem">
                <span className="k">{p.kind === 'reward' ? 'REP' : 'DEP'}</span>
                <div className="min-w-0">
                  <div className="nm truncate">{fmtUsdc(p.amount)}</div>
                  <div className="k mt-1 truncate">
                    to {account(p.destinationAddress ?? p.payTo)}
                  </div>
                </div>
                <div className="k hide-m">
                  <span className="eyebrow block mb-2">Route</span>
                  {p.route === '1click' ? 'NEAR Intents' : 'NEAR'}
                </div>
                <div className="k hide-m">
                  <span className="eyebrow block mb-2">Tx</span>
                  {p.nearTxHash ? (
                    <a
                      className="lnk-u"
                      href={links.nearTx(p.nearTxHash)}
                      {...ext}
                    >
                      {short(p.nearTxHash, 6, 4)}
                    </a>
                  ) : (
                    '—'
                  )}
                </div>
                <span
                  className={`pill ${p.status === 'failed' ? 'bad' : ['paid', 'bridged'].includes(p.status) ? 'ok' : 'lit'}`}
                >
                  {p.status}
                </span>
                <span />
              </div>
            ))}
          </div>
        </div>
        <div className="stick">
          {status === 'Breached' ? (
            <Claim caseId={id} />
          ) : (
            <div className="panel grid gap-4">
              <span className="eyebrow">What happens next</span>
              <p className="text-fg-2">
                {status === 'Reported' &&
                  'The MPC network answers within about 200 NEAR blocks. The watcher mirrors the result here.'}
                {status === 'DefenceOpen' &&
                  'The watcher defends automatically if it holds a matching announcement. Otherwise the case finalizes as a breach when the window closes.'}
                {status === 'Defended' &&
                  'Nothing further. The vault’s bond is untouched.'}
                {status === 'Paid' &&
                  'All shares have been paid out from the pool.'}
                {(status === 'Rejected' || status === 'Moot') &&
                  'Nothing further. The bond was never touched.'}
              </p>
              <div>
                <Cta to="/report" sm>
                  Report another change
                </Cta>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
