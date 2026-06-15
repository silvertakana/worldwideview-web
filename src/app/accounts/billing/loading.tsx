import styles from '../accounts.module.css'

export default function BillingLoading() {
  return (
    <div className={styles.pageContent}>
      <div className={`${styles.skeleton} ${styles.skeletonHeading}`} />
      <div className={`${styles.skeleton} ${styles.skeletonBadge}`} />
      <div className={`${styles.skeleton} ${styles.skeletonText}`} />
      <div className={`${styles.skeleton} ${styles.skeletonText}`} />
      <div className={`${styles.skeleton} ${styles.skeletonButton}`} />
    </div>
  )
}
