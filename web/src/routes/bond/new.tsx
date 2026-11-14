import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toEventSelector } from 'viem'
import type { EvmChain } from '@/lib/api/fw'
import Cta from '@/components/fw/Cta'
import NoticeDial from '@/components/fw/NoticeDial'
import PageHead from '@/components/fw/PageHead'
import { useChainClock, useChainInfo, useChains } from '@/hooks/useFw'
import { useNearAccount } from '@/hooks/useNearAccount'
import {
  buildRoot,
  getNonce,
  registerProtocol,
  verifySignIn,
} from '@/lib/api/fw'
import { callContract, callContracts, signNep413 } from '@/lib/near/wallet'
import { config } from '@/config'
import {
  NEAR_BLOCK_S,
  chainLabel,
  fmtDuration,
  fmtInt,
  fmtUsdc,
  isEvmAddress,
  nearToYocto,
  short,
  slugify,
  usdcToUnits,
} from '@/utils/fw'

export const Route = createFileRoute('/bond/new')({
  head: () => ({ meta: [{ title: 'Post a bond · Fair Warning' }] }),
  component: PostBond,
})

const EVENTS = [
  { sig: 'Upgraded(address)', label: 'Upgrades' },
  {
    sig: 'OwnershipTransferred(address,address)',
    label: 'Ownership transfers',
  },
  { sig: 'RoleGranted(bytes32,address,address)', label: 'Role grants' },
]
const COMMITMENT_STORAGE = (5n * 10n ** 22n).toString() // 0.05 NEAR, the contract's minimum
const ONE_YOCTO = '1'
const DRAFT_KEY = 'fw-bond-draft' // lets an owner resume after a refresh between wallet prompts

const hoursToNear = (h: number) => Math.round((h * 3600) / NEAR_BLOCK_S)
// the contract's finality grace on withdrawals (WITHDRAW_GRACE_* in lib.rs), in NEAR blocks
const WITHDRAW_GRACE_SAFE = 600
const WITHDRAW_GRACE_FINALIZED = 3000

interface Form {
  chain: EvmChain
  name: string
  vault: string
  announcer: string
  events: Array<string>
  noticeHours: string
  maxAgeDays: string
  finality: 'Safe' | 'Finalized'
  defenceMinutes: string
  withdrawalDays: string
  rootNoticeHours: string
  reportBondNear: string
  rewardPct: string
  bondUsdc: string
  balances: string
}

const INITIAL: Form = {
  chain: 'Base',
  name: '',
  vault: '',
  announcer: config.fw.announcerAddress,
  events: EVENTS.map((e) => e.sig),
  noticeHours: '24',
  maxAgeDays: '30',
  finality: 'Safe',
  defenceMinutes: '18',
  withdrawalDays: '7',
  rootNoticeHours: '169',
  reportBondNear: '0.5',
  rewardPct: '10',
  bondUsdc: '500',
  balances: '',
}

/** "0xabc…, 12.5" per line; amounts in USDC. Returns base units or the first bad line. */
const parseBalances = (text: string) => {
  const out: Array<{ address: string; amount: string }> = []
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const [i, line] of lines.entries()) {
    const [a, v] = line.split(/[,\s;]+/)
    const units = v ? usdcToUnits(v) : null
    if (!isEvmAddress(a) || units === null)
      return { error: `Line ${i + 1}: expected "0xaddress, amount"` }
    out.push({ address: a, amount: units.toString() })
  }
  if (out.length === 0) return { error: 'Add at least one depositor' }
  if (new Set(out.map((b) => b.address.toLowerCase())).size !== out.length)
    return { error: 'Each address may appear once' }
  return { balances: out }
}

type StepId = 'create' | 'signin' | 'register' | 'root' | 'fund'
const STEPS: Array<[StepId, string, string]> = [
  [
    'create',
    'Create the commitment',
    'fw.create_commitment · 0.05 NEAR for storage',
  ],
  ['signin', 'Sign in as the owner', 'NEP-413 message, no transaction'],
  [
    'register',
    'Register the vault',
    'adds it to the index so the watcher follows it',
  ],
  ['root', 'Commit the depositor list', 'Merkle root built from your list'],
  [
    'fund',
    'Set the root and post the bond',
    'fw.set_root + USDC ft_transfer_call, one approval',
  ],
]

interface Draft {
  commitmentId?: number
  slug?: string
  token?: string
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label className="label">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

function PostBond() {
  const navigate = useNavigate()
  const clock = useChainClock()
  const { accountId, connect } = useNearAccount()
  const [f, setF] = useState<Form>(INITIAL)
  const [draft, setDraft] = useState<Draft>({})
  const [running, setRunning] = useState<StepId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const set =
    <TKey extends keyof Form>(k: TKey) =>
    (v: Form[TKey]) =>
      setF((x) => ({ ...x, [k]: v }))

  useEffect(() => {
    try {
      const d = JSON.parse(
        sessionStorage.getItem(DRAFT_KEY) ?? '{}',
      ) as Draft & { form?: Form }
      if (d.form) setF({ ...INITIAL, ...d.form })
      setDraft({ commitmentId: d.commitmentId, slug: d.slug })
    } catch {}
  }, [])
  // the JWT stays in memory only; the draft keeps what the chain already knows
  const save = (d: Draft) => {
    setDraft(d)
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ commitmentId: d.commitmentId, slug: d.slug, form: f }),
      )
    } catch {}
  }

  const chains = useChains()
  const chain = useChainInfo(f.chain)
  // hours become blocks at the chain's measured pace; with no measurement yet there is nothing to convert
  const bs = chain.blockS ?? NaN
  const n = (s: string) => Number(s)
  const notice = Math.round((n(f.noticeHours) * 3600) / bs)
  const maxAge = Math.round((n(f.maxAgeDays) * 86400) / bs)
  const defence = Math.round((n(f.defenceMinutes) * 60) / NEAR_BLOCK_S)
  const withdrawal = hoursToNear(n(f.withdrawalDays) * 24)
  const rootNotice = hoursToNear(n(f.rootNoticeHours))
  const bond = usdcToUnits(f.bondUsdc)
  const reportBond = nearToYocto(f.reportBondNear)
  const rewardBps = Math.round(n(f.rewardPct) * 100)
  const slug = slugify(f.name)
  const parsed = useMemo(() => parseBalances(f.balances), [f.balances])

  const problems: Partial<Record<keyof Form, string>> = {}
  if (f.name.trim().length < 3 || slug.length < 3)
    problems.name = 'At least 3 letters or digits'
  if (!chain.blockS)
    problems.chain = `No block time for ${chain.label} yet; the indexer must watch it`
  if (!isEvmAddress(f.vault))
    problems.vault = `The vault proxy address on ${chain.label}`
  if (!isEvmAddress(f.announcer))
    problems.announcer = 'The Announcer contract you will announce through'
  if (f.events.length === 0)
    problems.events = 'Police at least one kind of admin change'
  if (!(notice > 0)) problems.noticeHours = 'More than zero'
  if (!(maxAge >= notice))
    problems.maxAgeDays = 'Must cover at least the notice period'
  if (!(defence >= 300))
    problems.defenceMinutes =
      'At least 300 NEAR blocks (about 3 minutes); the MPC answer must fit'
  if (!(withdrawal >= defence))
    problems.withdrawalDays = 'Must be longer than the defence window'
  // a new depositor list must not take effect faster than the bond could leave
  const rootNoticeMin =
    withdrawal + (f.finality === 'Safe' ? WITHDRAW_GRACE_SAFE : WITHDRAW_GRACE_FINALIZED)
  if (!(rootNotice >= rootNoticeMin))
    problems.rootNoticeHours = `At least the withdrawal notice plus finality, ${fmtInt(Math.ceil((rootNoticeMin * NEAR_BLOCK_S) / 3600))} hours`
  if (reportBond === null) problems.reportBondNear = 'A NEAR amount'
  if (!(rewardBps >= 0 && rewardBps <= 5000))
    problems.rewardPct = 'Between 0 and 50%'
  if (bond === null) problems.bondUsdc = 'A USDC amount'
  if (!parsed.balances) problems.balances = parsed.error
  const ok = Object.keys(problems).length === 0
  const err = (k: keyof Form) =>
    touched && problems[k] ? <span className="err">{problems[k]}</span> : null

  const done = (s: StepId) =>
    (s === 'create' && draft.commitmentId !== undefined) ||
    (s === 'signin' && !!draft.token) ||
    (s === 'register' && !!draft.slug)

  const run = async () => {
    setTouched(true)
    setError(null)
    if (!accountId) return connect()
    if (!ok || bond === null || reportBond === null || !parsed.balances) return
    let d = { ...draft }
    try {
      if (d.commitmentId === undefined) {
        setRunning('create')
        const params = {
          chain: f.chain,
          watched: [f.vault.toLowerCase()],
          watched_topics: f.events.map((e) => toEventSelector(e)),
          announcer: f.announcer.toLowerCase(),
          notice_blocks: notice,
          max_announce_age_blocks: maxAge,
          effective_from_block: clock.evm(f.chain) ?? 0,
          finality: f.finality,
          defence_window: defence,
          withdrawal_notice: withdrawal,
          root_notice: rootNotice,
          report_bond: reportBond.toString(),
          reward_bps: rewardBps,
        }
        const { value } = await callContract<number>({
          receiverId: config.fw.contractId,
          methodName: 'create_commitment',
          args: { params },
          gasTgas: 30,
          deposit: COMMITMENT_STORAGE,
        })
        if (value === null)
          throw new Error('The wallet did not return the commitment id')
        d = { ...d, commitmentId: value }
        save(d)
      }
      if (!d.token) {
        setRunning('signin')
        const nonce = await getNonce(accountId)
        const signed = await signNep413({
          message: nonce.message,
          recipient: nonce.recipient,
          nonceBase64: nonce.nonce,
        })
        const { token } = await verifySignIn({
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
        })
        d = { ...d, token }
        setDraft(d)
      }
      if (!d.slug) {
        setRunning('register')
        await registerProtocol(d.token!, {
          commitmentId: d.commitmentId!,
          slug,
          name: f.name.trim(),
        })
        d = { ...d, slug }
        save(d)
      }
      setRunning('root')
      const { setRootArgs } = await buildRoot(d.token!, d.slug!, {
        snapshotBlock: clock.evm(f.chain) ?? 0,
        balances: parsed.balances,
      })
      setRunning('fund')
      await callContracts([
        {
          receiverId: config.fw.contractId,
          methodName: 'set_root',
          args: setRootArgs,
          gasTgas: 30,
          deposit: ONE_YOCTO,
        },
        {
          receiverId: config.fw.usdcContractId,
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: config.fw.contractId,
            amount: bond.toString(),
            msg: JSON.stringify({ commitment_id: d.commitmentId }),
          },
          gasTgas: 100,
          deposit: ONE_YOCTO,
        },
      ])
      sessionStorage.removeItem(DRAFT_KEY)
      navigate({ to: '/bonds/$slug', params: { slug: d.slug! } })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  const promise = `${fmtDuration(n(f.noticeHours) * 3600)} notice · ${bond ? fmtUsdc(bond) : '—'} bond`

  return (
    <div className="page wrap pb-32">
      <PageHead
        index="[P]"
        eyebrow="Post a bond"
        title={
          <>
            Keep your emergency speed.{' '}
            <em className="serif">Put a price on it.</em>
          </>
        }
        sub="Promise depositors notice before any admin change, and back it with USDC on NEAR. Your admin key stays fast; skipping the notice pays them instead of hurting them."
        hud={
          <>
            Owner methods need a<br />
            <b>full-access key</b>
          </>
        }
      />

      <div className="split">
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
          noValidate
        >
          <div className="step-h">
            <span className="br">[01]</span>
            <h3>The vault</h3>
          </div>
          <div className="formgrid">
            <div className="full label">
              <span>Chain the vault lives on</span>
              <div className="seg" role="group" aria-label="Chain">
                {(chains.data ?? [{ chain: 'Base' as EvmChain }]).map((c) => (
                  <button
                    key={c.chain}
                    type="button"
                    aria-pressed={f.chain === c.chain}
                    onClick={() => set('chain')(c.chain)}
                    disabled={draft.commitmentId !== undefined}
                  >
                    {chainLabel(c.chain)}
                  </button>
                ))}
              </div>
              <span className="hint">
                The NEAR MPC network reads Base, Arbitrum, BNB Chain, Polygon,
                Avalanche, HyperEVM and Abstract. This indexer watches the ones
                listed.
              </span>
              {err('chain')}
            </div>
            <Field label="Name">
              <input
                className="field"
                value={f.name}
                onChange={(e) => set('name')(e.target.value)}
                placeholder="Acme USDC Vault"
                aria-invalid={touched && !!problems.name}
              />
              {err('name')}
            </Field>
            <Field
              label="Page"
              hint={slug ? `/bonds/${slug}` : 'from the name'}
            >
              <input className="field" value={slug} readOnly tabIndex={-1} />
            </Field>
            <Field
              label={`Vault proxy on ${chain.label}`}
              hint="Admin logs from this address are policed"
            >
              <input
                className="field"
                value={f.vault}
                onChange={(e) => set('vault')(e.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                aria-invalid={touched && !!problems.vault}
              />
              {err('vault')}
            </Field>
            <Field
              label={`Announcer on ${chain.label}`}
              hint="Announce here before each change"
            >
              <input
                className="field"
                value={f.announcer}
                onChange={(e) => set('announcer')(e.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                aria-invalid={touched && !!problems.announcer}
              />
              {err('announcer')}
            </Field>
            <div className="full label">
              <span>Policed changes</span>
              <div className="checks">
                {EVENTS.map((e) => (
                  <label key={e.sig} className="check">
                    <input
                      type="checkbox"
                      checked={f.events.includes(e.sig)}
                      onChange={(ev) =>
                        set('events')(
                          ev.target.checked
                            ? [...f.events, e.sig]
                            : f.events.filter((x) => x !== e.sig),
                        )
                      }
                    />
                    {e.label}
                  </label>
                ))}
              </div>
              {err('events')}
            </div>
          </div>

          <div className="step-h">
            <span className="br">[02]</span>
            <h3>The promise</h3>
          </div>
          <div className="formgrid">
            <Field
              label="Notice, hours"
              hint={`${fmtInt(notice || 0)} ${chain.label} blocks`}
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.noticeHours}
                onChange={(e) => set('noticeHours')(e.target.value)}
              />
              {err('noticeHours')}
            </Field>
            <Field
              label="Announcements valid for, days"
              hint={`${fmtInt(maxAge || 0)} ${chain.label} blocks`}
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.maxAgeDays}
                onChange={(e) => set('maxAgeDays')(e.target.value)}
              />
              {err('maxAgeDays')}
            </Field>
            <div className="label">
              <span>Finality to read</span>
              <div className="seg" role="group" aria-label="Finality">
                {(['Safe', 'Finalized'] as const).map((x) => (
                  <button
                    key={x}
                    type="button"
                    aria-pressed={f.finality === x}
                    onClick={() => set('finality')(x)}
                  >
                    {x}
                  </button>
                ))}
              </div>
              <span className="hint">
                {f.finality === 'Safe'
                  ? f.chain === 'Base'
                    ? 'Faster cases; Base marks blocks safe within about a minute.'
                    : "Faster cases; reads the chain's safe head."
                  : f.chain === 'Base'
                    ? 'Slower; finalized takes about 17 minutes.'
                    : 'Slower; waits for the finalized head.'}
              </span>
            </div>
            <Field
              label="Defence window, minutes"
              hint={`${fmtInt(defence || 0)} NEAR blocks to prove an announcement`}
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.defenceMinutes}
                onChange={(e) => set('defenceMinutes')(e.target.value)}
              />
              {err('defenceMinutes')}
            </Field>
            <Field
              label="Withdrawal notice, days"
              hint="The bond can't leave sooner, nor while a case is open"
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.withdrawalDays}
                onChange={(e) => set('withdrawalDays')(e.target.value)}
              />
              {err('withdrawalDays')}
            </Field>
            <Field
              label="Depositor list change notice, hours"
              hint="A new list takes effect after this; at least the withdrawal notice"
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.rootNoticeHours}
                onChange={(e) => set('rootNoticeHours')(e.target.value)}
              />
              {err('rootNoticeHours')}
            </Field>
            <Field
              label="Report bond, NEAR"
              hint="What a reporter risks if the change was announced"
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.reportBondNear}
                onChange={(e) => set('reportBondNear')(e.target.value)}
              />
              {err('reportBondNear')}
            </Field>
            <Field
              label="Reporter reward, %"
              hint="The rest goes to depositors"
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.rewardPct}
                onChange={(e) => set('rewardPct')(e.target.value)}
              />
              {err('rewardPct')}
            </Field>
          </div>

          <div className="step-h">
            <span className="br">[03]</span>
            <h3>The bond and who it protects</h3>
          </div>
          <div className="formgrid">
            <Field
              label="Bond, USDC"
              hint={`From ${accountId ? short(accountId, 14, 6) : 'your NEAR account'} on ${config.fw.usdcContractId.length > 20 ? 'native USDC' : config.fw.usdcContractId}`}
            >
              <input
                className="field"
                inputMode="decimal"
                value={f.bondUsdc}
                onChange={(e) => set('bondUsdc')(e.target.value)}
              />
              {err('bondUsdc')}
            </Field>
            <div />
            <Field
              label="Depositors at snapshot"
              hint={
                parsed.balances
                  ? `${parsed.balances.length} depositors · ${fmtUsdc(parsed.balances.reduce((s, b) => s + BigInt(b.amount), 0n))}`
                  : 'One "0xaddress, amount" per line, amounts in USDC'
              }
            >
              <textarea
                className="field full"
                value={f.balances}
                onChange={(e) => set('balances')(e.target.value)}
                placeholder={
                  '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A, 1200\n0x1563915e194D8CfBA1943570603F7606A3115508, 300.5'
                }
                spellCheck={false}
                aria-invalid={touched && !!problems.balances}
              />
              {err('balances')}
            </Field>
          </div>
        </form>

        <div className="stick grid gap-6">
          <NoticeDial
            block={() => clock.evm(f.chain)}
            blockS={chain.blockS}
            target={null}
            notice={notice || 1}
            idleText={promise}
            label="Your promise, live"
          />
          <div className="panel grid gap-5">
            <span className="eyebrow">Three wallet prompts, in order</span>
            <ol className="rail">
              {STEPS.map(([id, label, meta]) => (
                <li
                  key={id}
                  className={running === id ? 'lit' : done(id) ? 'ok' : 'todo'}
                >
                  <h4>{label}</h4>
                  <div className="meta">{meta}</div>
                </li>
              ))}
            </ol>
            {draft.commitmentId !== undefined && (
              <p className="hint">
                Commitment #{draft.commitmentId} exists on NEAR; the next run
                continues from there.
              </p>
            )}
            {error && <p className="err">{error}</p>}
            <div>
              <Cta solid onClick={run} disabled={running !== null}>
                {!accountId
                  ? 'Connect NEAR wallet'
                  : running
                    ? 'Confirm in your wallet'
                    : draft.commitmentId !== undefined
                      ? 'Continue'
                      : 'Post the bond'}
              </Cta>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
