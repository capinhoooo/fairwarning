import { Link, createFileRoute } from '@tanstack/react-router'
import type { Protocol } from '@/lib/api/fw'
import Cta from '@/components/fw/Cta'
import PageHead from '@/components/fw/PageHead'
import { Offline, Skeleton } from '@/components/fw/States'
import {
  CaseStatusPill,
  CoveragePill,
  coverage,
} from '@/components/fw/StatusPill'
import { useCases, useChains, useProtocols, useStats } from '@/hooks/useFw'
import {
  BASE_BLOCK_S,
  account,
  blocksToTime,
  chainLabel,
  fmtInt,
  fmtUsdc,
  short,
} from '@/utils/fw'

/** Notice as time on the vault's own chain, from the measured block time. */
const useNoticeText = () => {
  const { data } = useChains()
  return (p: Protocol) => {
    const s =
      data?.find((c) => c.chain === p.chain)?.blockTimeS ??
      (p.chain === 'Base' ? BASE_BLOCK_S : null)
    return blocksToTime(p.noticeBlocks, s) ?? `${fmtInt(p.noticeBlocks)} blocks`
  }
}

export const Route = createFileRoute('/bonds/')({
  head: () => ({ meta: [{ title: 'Bonded vaults · Fair Warning' }] }),
  component: Bonds,
})

/** One lighthouse per vault on a shared horizon: lit while covered, red once a breach paid out. */
function Coast({ protocols }: { protocols: Array<Protocol> }) {
  const notice = useNoticeText()
  const shown = protocols.slice(0, 12)
  if (shown.length === 0)
    return (
      <div className="coast">
        <div className="sea" />
        <div className="empty">
          <p>No vault has posted a bond yet. The coast is dark.</p>
          <div className="flex justify-center">
            <Cta to="/bond/new" solid sm>
              Light the first lamp
            </Cta>
          </div>
        </div>
      </div>
    )
  return (
    <div className="coast" role="list" aria-label="Bonded vaults">
      <div className="sea" />
      {shown.map((p, i) => {
        const x = `${((i + 1) / (shown.length + 1)) * 100}%`
        const [cls] = coverage(p)
        const lit = cls === 'ok' || cls === 'bad'
        return (
          <div key={p.slug} role="listitem">
            {lit && (
              <span
                className={`beamx ${cls === 'bad' ? 'bad' : ''}`}
                style={{ left: x, animationDelay: `${-i * 1.7}s` }}
                aria-hidden="true"
              />
            )}
            <Link
              to="/bonds/$slug"
              params={{ slug: p.slug }}
              className="tower"
              style={{ left: x }}
              aria-label={p.name}
            >
              <span
                className="lampx"
                style={
                  lit
                    ? {
                        background: cls === 'bad' ? 'var(--bad)' : '#fff',
                        boxShadow: `0 0 12px 3px ${cls === 'bad' ? 'var(--bad)' : 'var(--light)'}`,
                      }
                    : undefined
                }
              />
            </Link>
            <Link
              to="/bonds/$slug"
              params={{ slug: p.slug }}
              className="tag"
              style={{ left: x }}
            >
              <b>{p.name}</b>
              {notice(p)}
            </Link>
          </div>
        )
      })}
    </div>
  )
}

function Bonds() {
  const protocols = useProtocols()
  const stats = useStats()
  const cases = useCases()
  const notice = useNoticeText()
  const s = stats.data

  return (
    <div className="page wrap">
      <PageHead
        index="[B]"
        eyebrow="Bonded vaults"
        title={
          <>
            Every promise on the coast, <em className="serif">lit.</em>
          </>
        }
        sub="Each lamp is a commitment on NEAR. It burns while the bond is posted, the depositor list is set and no withdrawal is pending. A breach turns it red and pays the depositors."
        hud={
          <>
            Indexed from <b>NEAR</b> and <b>Base</b>
            <br />
            refreshes every <b>15 s</b>
          </>
        }
      />

      <div className="stats" aria-live="polite">
        <div>
          <span className="eyebrow">Bonded</span>
          <b>
            {s ? fmtUsdc(s.bonded).replace(' USDC', '') : '…'}
            <small>USDC</small>
          </b>
        </div>
        <div>
          <span className="eyebrow">Vaults covered</span>
          <b>
            {s ? s.covered : '…'}
            <small>/ {s ? s.protocols : '…'}</small>
          </b>
        </div>
        <div>
          <span className="eyebrow">Open cases</span>
          <b>{s ? s.openCases : '…'}</b>
        </div>
        <div>
          <span className="eyebrow">Paid to users</span>
          <b>
            {s ? fmtUsdc(s.paidOut).replace(' USDC', '') : '…'}
            <small>USDC</small>
          </b>
        </div>
      </div>

      <div className="mt-6">
        {protocols.isPending ? (
          <div className="coast" />
        ) : protocols.data ? (
          <Coast protocols={protocols.data} />
        ) : null}
      </div>

      <div className="shead">
        <div>
          <span className="br">[01]</span>
          <h2>The ledger</h2>
        </div>
        <Cta to="/bond/new" sm>
          Post a bond
        </Cta>
      </div>
      {protocols.isPending && <Skeleton />}
      {protocols.error && (
        <Offline error={protocols.error} retry={() => protocols.refetch()} />
      )}
      {protocols.data && (
        <div className="ledger" role="list">
          {protocols.data.length === 0 && (
            <p className="empty-note">Nothing bonded yet.</p>
          )}
          {protocols.data.map((p) => (
            <Link
              key={p.slug}
              to="/bonds/$slug"
              params={{ slug: p.slug }}
              className="lrow lrow-bonds"
              role="listitem"
            >
              <div className="min-w-0">
                <div className="nm truncate">{p.name}</div>
                <div className="k mt-1 truncate">
                  {chainLabel(p.chain)} · {short(p.vaultAddress, 8, 6)} ·
                  commitment #{p.commitmentId}
                </div>
              </div>
              <div className="k hide-m">
                <span className="eyebrow block mb-2">Notice</span>
                {notice(p)}
              </div>
              <div className="k hide-m">
                <span className="eyebrow block mb-2">Bond</span>
                {fmtUsdc(p.bond)}
              </div>
              <div className="k hide-m">
                <span className="eyebrow block mb-2">Cases</span>
                {fmtInt(p._count?.cases ?? 0)}
              </div>
              <CoveragePill protocol={p} />
              <span className="go" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      )}

      <div className="shead">
        <div>
          <span className="br">[02]</span>
          <h2>Recent cases</h2>
        </div>
        <Cta to="/report" sm>
          Report a breach
        </Cta>
      </div>
      {cases.isPending && <Skeleton rows={2} />}
      {cases.error && (
        <Offline error={cases.error} retry={() => cases.refetch()} />
      )}
      {cases.data && (
        <div className="ledger mb-32" role="list">
          {cases.data.length === 0 && (
            <p className="empty-note">
              No breach has been reported. Every lamp has kept its promise so
              far.
            </p>
          )}
          {cases.data.map((c) => (
            <Link
              key={c.caseId}
              to="/cases/$caseId"
              params={{ caseId: String(c.caseId) }}
              className="lrow lrow-cases"
              role="listitem"
            >
              <span className="k">#{c.caseId}</span>
              <div className="min-w-0">
                <div className="nm truncate">
                  {c.protocol?.name ?? 'Unknown vault'}
                </div>
                <div className="k mt-1 truncate">
                  tx {short(c.txHash, 10, 6)} · log {c.logIndex}
                </div>
              </div>
              <div className="k hide-m">
                <span className="eyebrow block mb-2">Reporter</span>
                {account(c.reporter)}
              </div>
              <div className="k hide-m">
                <span className="eyebrow block mb-2">Pool</span>
                {c.pool ? fmtUsdc(c.pool) : '—'}
              </div>
              <CaseStatusPill status={c.status} />
              <span className="go" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
