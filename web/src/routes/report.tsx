import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import type { PreparedReport } from '@/lib/api/fw'
import Cta from '@/components/fw/Cta'
import HashReveal from '@/components/fw/HashReveal'
import PageHead from '@/components/fw/PageHead'
import { Offline } from '@/components/fw/States'
import {
  useAdminEvents,
  useChainClock,
  useChainInfo,
  usePrepareReport,
} from '@/hooks/useFw'
import { useNearAccount } from '@/hooks/useNearAccount'
import { getCaseByLog } from '@/lib/api/fw'
import { callContract } from '@/lib/near/wallet'
import {
  EVENT_NAMES,
  blocksToTime,
  fmtInt,
  fmtNear,
  isTxHash,
  links,
  short,
} from '@/utils/fw'

export const Route = createFileRoute('/report')({
  validateSearch: z.object({ tx: z.string().optional() }),
  head: () => ({ meta: [{ title: 'Report a breach · Fair Warning' }] }),
  component: Report,
})

const ext = { target: '_blank', rel: 'noopener noreferrer' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Phase =
  | { at: 'idle' }
  | { at: 'signing' }
  | { at: 'sent'; hash: string }
  | { at: 'opened'; hash: string; caseId: number }
  | { at: 'failed'; error: string; hash?: string }

const VERDICT: Record<PreparedReport['verdict'], [string, string, string]> = {
  breach: [
    'bad',
    'No notice found',
    'The watcher found no announcement early enough for this log. If that holds, the case pays out.',
  ],
  announced: [
    'ok',
    'Announced in time',
    'This change matched an announcement. A report will be defended and you lose the report bond to the defender.',
  ],
  unknown: [
    '',
    'Not classified yet',
    'The watcher has not reached this block yet. You can still report; the contract checks everything itself.',
  ],
}

function Receipt({ r }: { r: PreparedReport }) {
  const navigate = useNavigate()
  const { accountId, connect } = useNearAccount()
  const clock = useChainClock()
  const [phase, setPhase] = useState<Phase>({ at: 'idle' })
  const [anyway, setAnyway] = useState(false)
  const [cls, label, explain] = VERDICT[r.verdict]
  const event = EVENT_NAMES[r.log.topics[0]] ?? 'Admin log'
  const chain = useChainInfo(r.chain)

  // the MPC network refuses logs above the requested finality, so a too-fresh report would only be rejected
  const safe = clock.heads ? clock.safe(chain.chain) : null
  const wait =
    r.finality === 'Safe' && safe !== null
      ? Math.max(0, r.log.block_number - safe)
      : 0
  const blocked =
    wait > 0 ||
    (r.verdict === 'announced' && !anyway) ||
    phase.at === 'signing' ||
    phase.at === 'sent'

  const send = async () => {
    if (!accountId) return connect()
    setPhase({ at: 'signing' })
    let hash: string | undefined
    try {
      const tx = await callContract({
        receiverId: r.report.contractId,
        methodName: r.report.method,
        args: r.report.args,
        gasTgas: r.report.gasTgas,
        deposit: r.report.deposit,
      })
      hash = tx.hash
      setPhase({ at: 'sent', hash })
      // the case is created in the same receipt as the MPC call, so it exists as soon as the tx lands
      for (let i = 0; i < 30; i++) {
        const { caseId } = await getCaseByLog(
          r.commitmentId,
          r.log.tx_hash,
          r.log.log_index,
        )
        if (caseId !== null) {
          setPhase({ at: 'opened', hash, caseId })
          return navigate({
            to: '/cases/$caseId',
            params: { caseId: String(caseId) },
          })
        }
        await sleep(2000)
      }
      setPhase({
        at: 'failed',
        hash,
        error:
          'The transaction went through but no case appeared. Check it on the explorer.',
      })
    } catch (e) {
      setPhase({ at: 'failed', hash, error: (e as Error).message })
    }
  }

  return (
    <article className="receipt">
      <div className="rhead">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">Policed log</span>
          <Link
            to="/bonds/$slug"
            params={{ slug: r.protocol }}
            className="lnk-u"
          >
            {r.protocolName}
          </Link>
        </div>
        <span className={`pill ${cls}`}>{label}</span>
      </div>
      <div className="rbody">
        <div className="grid content-start gap-5">
          <div className="kv">
            <div>
              <span className="eyebrow">Event</span>
              <span>{event}</span>
            </div>
            <div>
              <span className="eyebrow">Emitted by</span>
              <a href={chain.links.addr(r.log.address)} {...ext}>
                {short(r.log.address, 10, 8)}
              </a>
            </div>
            <div>
              <span className="eyebrow">Block · log</span>
              <a href={chain.links.tx(r.log.tx_hash)} {...ext}>
                {fmtInt(r.log.block_number)} · {r.log.log_index}
              </a>
            </div>
            <div>
              <span className="eyebrow">Finality read</span>
              <span>
                {chain.label} · {r.finality}
              </span>
            </div>
          </div>
          <div>
            <span className="eyebrow">The NEAR MPC network will sign</span>
            <p className="hash mt-3">
              <HashReveal value={r.expectedPayloadHash} />
            </p>
            <p className="hint mt-2">
              Computed here from the log; the contract only accepts a signature
              over exactly this hash.
            </p>
          </div>
        </div>
        <div className="grid content-start gap-5">
          <p className="text-fg-2">{explain}</p>
          {r.caseId !== null ? (
            <div className="grid gap-4">
              <p>Already reported as case #{r.caseId}.</p>
              <div>
                <Cta
                  to="/cases/$caseId"
                  params={{ caseId: String(r.caseId) }}
                  solid
                >{`Follow case #${r.caseId}`}</Cta>
              </div>
            </div>
          ) : !r.active ? (
            <p className="hint">
              This bond has already paid out on another case, so the contract
              accepts no new reports against it.
            </p>
          ) : (
            <>
              <div className="kv">
                <div>
                  <span className="eyebrow">You attach</span>
                  <span>{fmtNear(r.report.deposit)}</span>
                </div>
                <div>
                  <span className="eyebrow">Back to you</span>
                  <span>all but 0.01 NEAR, unless defended</span>
                </div>
                <div>
                  <span className="eyebrow">Your reward</span>
                  <span>the reporter's share of the bond</span>
                </div>
              </div>
              {wait > 0 && (
                <p className="hint">
                  {chain.label} marks this block safe in{' '}
                  {blocksToTime(wait, chain.blockS)
                    ? `about ${blocksToTime(wait, chain.blockS)} (${fmtInt(wait)} blocks)`
                    : `${fmtInt(wait)} blocks`}
                  . The MPC network won't read it before then.
                </p>
              )}
              {r.verdict === 'announced' && (
                <label className="check w-fit">
                  <input
                    type="checkbox"
                    checked={anyway}
                    onChange={(e) => setAnyway(e.target.checked)}
                  />
                  Report anyway and risk the bond
                </label>
              )}
              <div className="flex flex-wrap gap-2.5">
                <Cta solid onClick={send} disabled={!!accountId && blocked}>
                  {!accountId
                    ? 'Connect NEAR wallet'
                    : phase.at === 'signing'
                      ? 'Confirm in your wallet'
                      : phase.at === 'sent'
                        ? 'Opening the case'
                        : 'Sign report on NEAR'}
                </Cta>
              </div>
              {phase.at !== 'idle' && (
                <ol className="rail">
                  <li
                    className={
                      phase.at === 'signing'
                        ? 'lit'
                        : phase.at === 'failed' && !phase.hash
                          ? 'bad'
                          : 'done'
                    }
                  >
                    <h4>Sign fw.report</h4>
                    <div className="meta">
                      {r.report.contractId} · {r.report.gasTgas} Tgas
                    </div>
                  </li>
                  <li
                    className={
                      phase.at === 'sent'
                        ? 'lit'
                        : phase.at === 'opened'
                          ? 'done'
                          : phase.at === 'failed' && phase.hash
                            ? 'bad'
                            : 'todo'
                    }
                  >
                    <h4>Case opens, MPC reads {chain.label}</h4>
                    {'hash' in phase && phase.hash && (
                      <div className="meta">
                        <a
                          className="lnk-u"
                          href={links.nearTx(phase.hash)}
                          {...ext}
                        >
                          {short(phase.hash, 10, 8)}
                        </a>
                      </div>
                    )}
                  </li>
                </ol>
              )}
              {phase.at === 'failed' && <p className="err">{phase.error}</p>}
            </>
          )}
        </div>
      </div>
    </article>
  )
}

function Report() {
  const { tx } = Route.useSearch()
  const [value, setValue] = useState(tx ?? '')
  const [touched, setTouched] = useState(false)
  const prepare = usePrepareReport()
  const recent = useAdminEvents()
  const valid = isTxHash(value)

  const check = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (valid) prepare.mutate({ txHash: value.trim() })
  }
  // a dry run on real data: any indexed admin log can be checked without a wallet
  const tryTx = (txHash: string) => {
    setValue(txHash)
    setTouched(true)
    prepare.mutate({ txHash })
  }

  return (
    <div className="page wrap pb-32">
      <PageHead
        index="[R]"
        eyebrow="Report a breach"
        title={
          <>
            Saw an upgrade <em className="serif">without notice?</em>
          </>
        }
        sub="Paste the transaction from any watched chain. We find the policed admin log, show the exact hash the NEAR MPC network will sign, and you send the report from your NEAR wallet. If it holds, the reporter's share of the bond is yours."
        hud={
          <>
            Reports are checked by
            <br />
            <b>Read MPC</b> on 7 EVM chains
          </>
        }
      />

      <form className="bar" onSubmit={check} noValidate>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x… transaction hash"
          aria-label="Transaction hash"
          aria-invalid={touched && !valid}
          spellCheck={false}
          autoComplete="off"
        />
        <Cta type="submit" solid disabled={prepare.isPending}>
          {prepare.isPending ? 'Reading the chain' : 'Check transaction'}
        </Cta>
      </form>
      {touched && !valid && (
        <p className="err mt-3">
          A transaction hash is 0x followed by 64 hex characters.
        </p>
      )}
      {recent.data && recent.data.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="eyebrow mr-1">Try a real one</span>
          {recent.data.map((e) => (
            <button
              key={`${e.txHash}:${e.logIndex}`}
              type="button"
              className="pill max-w-full"
              title={e.protocol.name}
              onClick={() => tryTx(e.txHash)}
              disabled={prepare.isPending}
            >
              <span className="truncate">
                {e.protocol.name} · {EVENT_NAMES[e.topic0] ?? 'admin log'} ·{' '}
                {e.verdict === 'breach' ? 'no notice' : 'announced'}
              </span>
            </button>
          ))}
          <span className="hint">
            Checking needs no wallet; only signing does.
          </span>
        </div>
      )}

      <div className="mt-10 grid gap-6">
        {prepare.error && <Offline error={prepare.error} />}
        {prepare.data?.map((r) => (
          <Receipt
            key={`${r.commitmentId}:${r.log.tx_hash}:${r.log.log_index}`}
            r={r}
          />
        ))}
        {!prepare.data && !prepare.error && (
          <ol className="rail mt-4 max-w-2xl">
            <li className="done">
              <h4>Paste the transaction that changed the vault</h4>
              <p>
                Upgrades, ownership transfers and role grants on a bonded vault
                are policed.
              </p>
            </li>
            <li className="done">
              <h4>Check the receipt</h4>
              <p>
                You see whether an announcement covered it and the hash the MPC
                network will sign.
              </p>
            </li>
            <li className="done">
              <h4>Sign on NEAR</h4>
              <p>
                The contract opens a case, asks the MPC network to read the
                chain, and gives the team a window to prove notice.
              </p>
            </li>
          </ol>
        )}
      </div>
    </div>
  )
}
