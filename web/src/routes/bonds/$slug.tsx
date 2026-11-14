import { Link, createFileRoute } from '@tanstack/react-router'
import type { ProtocolDetail } from '@/lib/api/fw'
import Cta from '@/components/fw/Cta'
import NoticeDial from '@/components/fw/NoticeDial'
import PageHead from '@/components/fw/PageHead'
import { Offline, Skeleton } from '@/components/fw/States'
import { CaseStatusPill, CoveragePill } from '@/components/fw/StatusPill'
import { useChainClock, useChainInfo, useProtocol } from '@/hooks/useFw'
import {
  EVENT_NAMES,
  account,
  blocksToTime,
  describeExpectedLog,
  fmtInt,
  fmtUsdc,
  links,
  nearBlocksToTime,
  short,
} from '@/utils/fw'

export const Route = createFileRoute('/bonds/$slug')({
  head: () => ({ meta: [{ title: 'Vault · Fair Warning' }] }),
  component: Vault,
})

const ext = { target: '_blank', rel: 'noopener noreferrer' }

type Entry =
  | {
      kind: 'ann'
      block: number
      key: string
      a: ProtocolDetail['announcements'][number]
    }
  | {
      kind: 'evt'
      block: number
      key: string
      e: ProtocolDetail['adminEvents'][number]
    }

/** Announcements that no admin log has used yet; the newest one sets the dial. */
const pendingAnnouncement = (p: ProtocolDetail) => {
  const used = new Set(
    p.adminEvents.map((e) => e.announcementId).filter(Boolean),
  )
  return p.announcements.find((a) => !used.has(a.id)) ?? null
}

type ChainInfo = ReturnType<typeof useChainInfo>
const asTime = (blocks: number, chain: ChainInfo) =>
  blocksToTime(blocks, chain.blockS) ??
  `${fmtInt(blocks)} ${chain.label} blocks`

function Timeline({ p, chain }: { p: ProtocolDetail; chain: ChainInfo }) {
  const entries: Array<Entry> = [
    ...p.announcements.map((a) => ({
      kind: 'ann' as const,
      block: Number(a.blockNumber),
      key: `a${a.id}`,
      a,
    })),
    ...p.adminEvents.map((e) => ({
      kind: 'evt' as const,
      block: Number(e.blockNumber),
      key: `e${e.id}`,
      e,
    })),
  ].sort((x, y) => y.block - x.block)
  if (entries.length === 0)
    return (
      <p className="empty-note">
        No admin action yet. The admin key has been quiet since the bond was
        posted.
      </p>
    )
  return (
    <ol className="rail">
      {entries.map((x) =>
        x.kind === 'ann' ? (
          <li key={x.key} className="lit">
            <h4>Announced: {describeExpectedLog(x.a.expectedLog)}</h4>
            <p>
              Allowed from block {fmtInt(x.block + p.noticeBlocks)},{' '}
              {asTime(p.noticeBlocks, chain)} after the announcement.
            </p>
            <div className="meta">
              block{' '}
              <a className="lnk-u" href={chain.links.block(x.block)} {...ext}>
                {fmtInt(x.block)}
              </a>{' '}
              · tx{' '}
              <a className="lnk-u" href={chain.links.tx(x.a.txHash)} {...ext}>
                {short(x.a.txHash, 10, 6)}
              </a>{' '}
              · action {short(x.a.actionHash, 10, 6)}
            </div>
          </li>
        ) : (
          <li key={x.key} className={x.e.verdict === 'breach' ? 'bad' : 'ok'}>
            <h4>
              {EVENT_NAMES[x.e.topic0] ?? 'Admin log'}{' '}
              {x.e.verdict === 'breach' ? 'without notice' : 'after notice'}
            </h4>
            {x.e.verdict === 'breach' ? (
              <p>
                No matching announcement early enough.{' '}
                {x.e.caseId !== null ? (
                  <Link
                    to="/cases/$caseId"
                    params={{ caseId: String(x.e.caseId) }}
                    className="lnk-u"
                  >
                    Case #{x.e.caseId}
                  </Link>
                ) : (
                  <Link
                    to="/report"
                    search={{ tx: x.e.txHash }}
                    className="lnk-u"
                  >
                    Report it
                  </Link>
                )}
              </p>
            ) : (
              <p>
                Matched an announcement made at least{' '}
                {asTime(p.noticeBlocks, chain)} earlier. Nothing to pay.
              </p>
            )}
            <div className="meta">
              block{' '}
              <a className="lnk-u" href={chain.links.block(x.block)} {...ext}>
                {fmtInt(x.block)}
              </a>{' '}
              · tx{' '}
              <a className="lnk-u" href={chain.links.tx(x.e.txHash)} {...ext}>
                {short(x.e.txHash, 10, 6)}
              </a>{' '}
              · log {x.e.logIndex}
            </div>
          </li>
        ),
      )}
    </ol>
  )
}

function Vault() {
  const { slug } = Route.useParams()
  const q = useProtocol(slug)
  const clock = useChainClock()
  const p = q.data
  const chain = useChainInfo(p?.chain)

  if (q.error)
    return (
      <div className="page wrap pb-32">
        <PageHead
          index="[B]"
          eyebrow="Vault"
          title={
            <>
              This lamp <em className="serif">isn't on the map.</em>
            </>
          }
        />
        <Offline error={q.error} retry={() => q.refetch()} />
        <div className="mt-8">
          <Cta to="/bonds">All bonded vaults</Cta>
        </div>
      </div>
    )
  if (!p)
    return (
      <div className="page wrap pb-32">
        <Skeleton rows={6} />
      </div>
    )

  const pending = pendingAnnouncement(p)
  const target = pending ? Number(pending.blockNumber) + p.noticeBlocks : null

  return (
    <div className="page wrap pb-32">
      <PageHead
        index="[B]"
        eyebrow={`Vault · commitment #${p.commitmentId}`}
        titleKey={p.name}
        title={
          <>
            {p.name}{' '}
            <em className="serif">
              gives {asTime(p.noticeBlocks, chain)} of notice.
            </em>
          </>
        }
        sub={
          <>
            Any change by its admin key that skips the notice pays the{' '}
            {fmtUsdc(p.bond)} bond to depositors. The bond sits on NEAR, out of
            reach of the key it polices.
          </>
        }
        hud={<CoveragePill protocol={p} />}
      />

      <div className="split">
        <div>
          <div className="kv">
            <div>
              <span className="eyebrow">Vault on {chain.label}</span>
              <a href={chain.links.addr(p.vaultAddress)} {...ext}>
                {short(p.vaultAddress, 10, 8)}
              </a>
            </div>
            <div>
              <span className="eyebrow">Announcer</span>
              <a href={chain.links.addr(p.announcerAddress)} {...ext}>
                {short(p.announcerAddress, 10, 8)}
              </a>
            </div>
            <div>
              <span className="eyebrow">Notice</span>
              <span>
                {fmtInt(p.noticeBlocks)} blocks
                {chain.blockS
                  ? ` · ${blocksToTime(p.noticeBlocks, chain.blockS)}`
                  : ''}
              </span>
            </div>
            <div>
              <span className="eyebrow">Announcements valid for</span>
              <span>{asTime(p.maxAnnounceAgeBlocks, chain)}</span>
            </div>
            <div>
              <span className="eyebrow">Finality read</span>
              <span>
                {chain.label} · {p.finality}
              </span>
            </div>
            <div>
              <span className="eyebrow">Defence window</span>
              <span>
                {fmtInt(p.defenceWindow)} NEAR blocks ·{' '}
                {nearBlocksToTime(p.defenceWindow)}
              </span>
            </div>
            <div>
              <span className="eyebrow">Bond</span>
              <span>{fmtUsdc(p.bond)}</span>
            </div>
            <div>
              <span className="eyebrow">Owner</span>
              <a href={links.nearAccount(p.ownerNearAccount)} {...ext}>
                {account(p.ownerNearAccount)}
              </a>
            </div>
            <div>
              <span className="eyebrow">Policed since</span>
              <span>block {fmtInt(p.effectiveFromBlock)}</span>
            </div>
          </div>
          <div className="acts">
            <Cta to="/report" solid>
              Report a change
            </Cta>
            <Cta href={chain.links.addr(p.vaultAddress)}>
              {`Open on ${chain.links.name}`}
            </Cta>
          </div>
        </div>
        <div className="stick">
          <NoticeDial
            block={() => clock.evm(chain.chain)}
            target={target}
            notice={p.noticeBlocks}
            label={`${chain.label} block`}
            blockS={chain.blockS}
            idleText={
              p.status === 'Breached' ? 'Promise broken' : 'No change announced'
            }
          />
          <p className="hint mt-4 text-center">
            {pending ? (
              <>Announced: {describeExpectedLog(pending.expectedLog)}</>
            ) : (
              `The hand keeps time with ${chain.label}. An announcement starts the notice arc.`
            )}
          </p>
        </div>
      </div>

      <div className="shead">
        <div>
          <span className="br">[01]</span>
          <h2>Everything the admin key did</h2>
        </div>
        <span className="eyebrow">
          {p.announcements.length} announced · {p.adminEvents.length} admin{' '}
          {p.adminEvents.length === 1 ? 'log' : 'logs'}
        </span>
      </div>
      <Timeline p={p} chain={chain} />

      <div className="shead">
        <div>
          <span className="br">[02]</span>
          <h2>Cases</h2>
        </div>
      </div>
      <div className="ledger" role="list">
        {p.cases.length === 0 && (
          <p className="empty-note">
            No case has been opened against this vault.
          </p>
        )}
        {p.cases.map((c) => (
          <Link
            key={c.caseId}
            to="/cases/$caseId"
            params={{ caseId: String(c.caseId) }}
            className="lrow lrow-cases"
            role="listitem"
          >
            <span className="k">#{c.caseId}</span>
            <div className="min-w-0">
              <div className="nm truncate">tx {short(c.txHash, 10, 6)}</div>
              <div className="k mt-1 truncate">
                log {c.logIndex} · reported by {account(c.reporter)}
              </div>
            </div>
            <div className="k hide-m">
              <span className="eyebrow block mb-2">Reward</span>
              {c.reward ? fmtUsdc(c.reward) : '—'}
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
    </div>
  )
}
