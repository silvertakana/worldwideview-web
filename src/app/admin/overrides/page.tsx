import { requireAdmin } from '@/lib/auth/admin'
import { OverrideConsole } from './OverrideConsole'
import styles from './overrides.module.css'

export default async function AdminOverridesPage() {
  await requireAdmin()

  return (
    <div className={styles.page}>
      <h2 className={styles.heading}>Manual billing override</h2>
      <p className={styles.intro}>
        Fix one customer&apos;s access by hand when billing has left them locked out. Every grant
        needs a reason: it is the only record of why this customer has access.
      </p>
      <p className={styles.intro}>
        A grant is written in two places. The hub records the decision and the reason; the globe
        receives the tier, because that is where the customer&apos;s actual access lives. If the hub
        write lands and the globe push does not, the customer still has no access and the screen
        says so, with a retry.
      </p>
      <OverrideConsole />
    </div>
  )
}
