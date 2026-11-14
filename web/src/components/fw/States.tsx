import Cta from '@/components/fw/Cta'
import { ApiError } from '@/lib/api/fw'

export const Skeleton = ({ rows = 3 }: { rows?: number }) => (
  <div aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div className="skeleton" key={i} />
    ))}
  </div>
)

const TITLES: Record<string, string> = {
  NO_ADMIN_LOG: 'Nothing to report here',
  INVALID_TX_HASH: 'Not a transaction hash',
  BASE_RPC_ERROR: 'Base could not be read',
}

/** The backend is the indexer; when it is down, say so plainly instead of showing empty data. */
export const Offline = ({
  error,
  retry,
}: {
  error: Error
  retry?: () => void
}) => (
  <div className="panel flex flex-wrap items-center justify-between gap-4">
    <div>
      <span className="eyebrow">
        {error instanceof ApiError
          ? (TITLES[error.code] ?? (error.status >= 500 ? 'Indexer error' : 'Not found'))
          : 'Indexer unreachable'}
      </span>
      <p className="mt-2 text-fg-2">{error.message}</p>
    </div>
    {retry && (
      <Cta onClick={retry} sm>
        Try again
      </Cta>
    )}
  </div>
)
