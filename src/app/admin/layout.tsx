import { requireAdmin } from '@/lib/auth/admin'
import Link from 'next/link'
import styles from './admin.module.css'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireAdmin()

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <h1 className={styles.title}>Admin Dashboard</h1>
        <nav className={styles.nav}>
          <Link href="/admin/codes" className={styles.navLink}>
            Codes
          </Link>
        </nav>
      </header>
      <main className={styles.content}>{children}</main>
    </div>
  )
}
