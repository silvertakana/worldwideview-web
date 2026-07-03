'use client'

import { useState } from 'react'
import { revokeCode } from './actions'
import styles from './CodesTable.module.css'
import type { AccessCode } from './page'

function getStatus(code: AccessCode): { label: string; className: string } {
  if (code.revoked_at) return { label: 'Revoked', className: styles.statusRevoked }
  if (code.expires_at && new Date(code.expires_at) < new Date())
    return { label: 'Expired', className: styles.statusExpired }
  if (code.use_count >= code.max_uses)
    return { label: 'Redeemed', className: styles.statusRedeemed }
  return { label: 'Available', className: styles.statusAvailable }
}

function CodeRow({ code }: { code: AccessCode }) {
  const [revoking, setRevoking] = useState(false)
  const status = getStatus(code)
  const canRevoke = !code.revoked_at

  async function handleRevoke() {
    if (!confirm('Revoke this access code? It can no longer be used.')) return
    setRevoking(true)
    await revokeCode(code.id)
    setRevoking(false)
  }

  return (
    <tr>
      <td className={styles.codeCell}>
        <code>{code.code}</code>
      </td>
      <td>
        <span className={`${styles.status} ${status.className}`}>
          {status.label}
        </span>
      </td>
      <td>{code.grants_days}</td>
      <td>{code.use_count}/{code.max_uses}</td>
      <td className={styles.notesCell}>{code.notes || '-'}</td>
      <td>{new Date(code.created_at).toLocaleDateString()}</td>
      <td>
        {canRevoke && (
          <button
            onClick={handleRevoke}
            disabled={revoking}
            className={styles.revokeButton}
          >
            {revoking ? 'Revoking...' : 'Revoke'}
          </button>
        )}
      </td>
    </tr>
  )
}

export function CodesTable({ codes }: { codes: AccessCode[] }) {
  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Access Codes</h2>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Days</th>
              <th>Uses</th>
              <th>Notes</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 ? (
              <tr>
                <td colSpan={7} className={styles.empty}>
                  No access codes yet.
                </td>
              </tr>
            ) : (
              codes.map(code => <CodeRow key={code.id} code={code} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
