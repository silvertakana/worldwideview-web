'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { deleteAccount } from './actions'
import hubStyles from '../hub/hub.module.css'
import styles from './accounts.module.css'

interface DeleteAccountModalProps {
  open: boolean
  onClose: () => void
}

export function DeleteAccountModal({ open, onClose }: DeleteAccountModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      dialog.showModal()
      cancelRef.current?.focus()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [open])

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteAccount()
      if (result && !result.success) {
        setError(result.error ?? 'Something went wrong. Please try again.')
      }
      // On success, deleteAccount() calls redirect('/') server-side,
      // so this branch is only reached on error.
    })
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.modalCard}
      aria-labelledby="delete-title"
      aria-describedby="delete-desc"
      onClose={onClose}
    >
      <div>
        <h2 id="delete-title" className={styles.modalTitle}>
          Delete Account?
        </h2>
        <p id="delete-desc" className={styles.modalBody}>
          This permanently deletes your WorldWideView account and all associated data. This cannot
          be undone.
        </p>
        {error && (
          <p className={styles.inlineError} role="alert">
            {error}
          </p>
        )}
        <div className={styles.modalButtons}>
          <button
            className={hubStyles.submitButton}
            onClick={handleDelete}
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? 'Deleting...' : 'Delete My Account'}
          </button>
          <button
            ref={cancelRef}
            className={styles.modalCancelButton}
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  )
}
