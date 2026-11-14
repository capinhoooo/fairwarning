import Cta from './Cta'
import PageHead from './PageHead'

export default function NotFound() {
  return (
    <div className="page wrap pb-32">
      <PageHead
        index="[404]"
        eyebrow="Not found"
        title={
          <>
            Nothing on this <em className="serif">stretch of coast.</em>
          </>
        }
        sub="The page you asked for doesn't exist. Every bonded vault, case and report starts from one of these."
      />
      <div className="mt-8 flex flex-wrap gap-3">
        <Cta to="/bonds" solid>
          Bonded vaults
        </Cta>
        <Cta to="/report">Report a breach</Cta>
        <Cta to="/">Home</Cta>
      </div>
    </div>
  )
}
