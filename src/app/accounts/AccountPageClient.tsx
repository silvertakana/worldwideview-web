'use client'

import { useState } from 'react'
import { CheckCircle2, Link2 } from 'lucide-react'
import { updateDisplayName, signOut } from './actions'
import { AvatarUpload } from './AvatarUpload'
import { DeleteAccountModal } from './DeleteAccountModal'
import LinkedAccounts from './LinkedAccounts'
import hubStyles from '../hub/hub.module.css'
import styles from './accounts.module.css'

interface AccountPageClientProps {
  email: string
  initialDisplayName: string | null
  initialAvatarUrl: string | null
  justLinked?: boolean
}

export function AccountPageClient({
  email,
  initialDisplayName,
  initialAvatarUrl,
  justLinked = false,
}: AccountPageClientProps) {
  const [editMode, setEditMode] = useState(false)
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div className={hubStyles.hubContainer}>
      <div className={hubStyles.glassCard} style={{ maxWidth: '480px', marginTop: '6vh' }}>
        <h1 className={hubStyles.title}>Your Account</h1>

        {justLinked && (
          <div className={styles.linkedSuccessBanner} role="status">
            <CheckCircle2 size={18} className={styles.linkedSuccessIcon} />
            <span>GitHub account linked successfully.</span>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-lg)' }}>
          <AvatarUpload
            name={displayName || email}
            initialAvatarUrl={initialAvatarUrl}
          />
        </div>

        <p
          style={{
            textAlign: 'center',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-lg)',
          }}
        >
          Signed in as <strong style={{ color: 'var(--color-text-primary)' }}>{email}</strong>
        </p>

        {/* Display name section */}
        <span className={styles.fieldLabel}>Display Name</span>
        {!editMode ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            {displayName ? (
              <span className={styles.idleDisplayName}>{displayName}</span>
            ) : (
              <span className={styles.emptyDisplayName}>No display name set</span>
            )}
            <button
              className={styles.editLink}
              onClick={() => setEditMode(true)}
              aria-label="Edit display name"
            >
              Edit
            </button>
          </div>
        ) : (
          <form
            action={async (fd) => {
              setSaveStatus('saving')
              setSaveError(null)
              const result = await updateDisplayName(fd)
              if (result.success) {
                setDisplayName(String(fd.get('displayName') ?? displayName))
                setEditMode(false)
                setSaveStatus('saved')
                setTimeout(() => setSaveStatus('idle'), 2000)
              } else {
                setSaveStatus('error')
                setSaveError(result.error ?? 'Could not save. Try again.')
              }
            }}
          >
            <div className={styles.editRow}>
              <input
                className={hubStyles.inputField}
                type="text"
                name="displayName"
                defaultValue={displayName}
                autoFocus
                maxLength={60}
                style={{ marginBottom: 0 }}
              />
              <button
                className={styles.saveButton}
                type="submit"
                disabled={saveStatus === 'saving'}
              >
                {saveStatus === 'saving' ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                type="button"
                className={styles.cancelLink}
                onClick={() => {
                  setEditMode(false)
                  setSaveStatus('idle')
                  setSaveError(null)
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Inline save status */}
        {saveStatus === 'saved' && (
          <p className={styles.inlineSuccess} role="status">
            Saved.
          </p>
        )}
        {saveStatus === 'error' && saveError && (
          <p className={styles.inlineError} role="alert">
            {saveError}
          </p>
        )}

        <hr className={styles.sectionDivider} />

        {/* Linked accounts */}
        <div className={styles.sectionHeading}>
          <Link2 size={16} className={styles.sectionIcon} />
          <span className={styles.fieldLabel} style={{ marginBottom: 0 }}>Linked Accounts</span>
        </div>
        <LinkedAccounts />

        <hr className={styles.sectionDivider} />

        {/* Sign out */}
        <form action={signOut}>
          <button className={hubStyles.submitButton} type="submit">
            Sign Out
          </button>
        </form>

        <hr className={styles.sectionDivider} />

        {/* Delete account */}
        <button className={styles.dangerButton} onClick={() => setModalOpen(true)}>
          Delete Account
        </button>

        {/* Confirmation modal */}
        <DeleteAccountModal open={modalOpen} onClose={() => setModalOpen(false)} />
      </div>
    </div>
  )
}
