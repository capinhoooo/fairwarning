import type { CaseStatus, Protocol } from '@/lib/api/fw'

const CASE: Record<CaseStatus, [string, string]> = {
  Reported: ['lit', 'MPC checking'],
  DefenceOpen: ['lit', 'Defence open'],
  Defended: ['ok', 'Defended'],
  Breached: ['bad', 'Breach'],
  Paid: ['bad', 'Paid out'],
  Rejected: ['', 'Rejected'],
  Moot: ['', 'Moot'],
}

export const CaseStatusPill = ({ status }: { status: CaseStatus }) => {
  const [cls, label] = CASE[status]
  return <span className={`pill ${cls}`}>{label}</span>
}

export const coverage = (
  p: Pick<Protocol, 'status' | 'covered'>,
): [string, string] =>
  p.status === 'Breached'
    ? ['bad', 'Breached']
    : p.status === 'Closed'
      ? ['', 'Closed']
      : p.covered
        ? ['ok', 'Covered']
        : ['', 'Not covered']

export const CoveragePill = ({
  protocol,
}: {
  protocol: Pick<Protocol, 'status' | 'covered'>
}) => {
  const [cls, label] = coverage(protocol)
  return <span className={`pill ${cls}`}>{label}</span>
}
