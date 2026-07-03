'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { BILLING_ENABLED } from '@/lib/billing/constants'
import CreateInstanceForm from './CreateInstanceForm'
import styles from './hub.module.css'

interface Workspace {
  id: string
  name: string
  subdomain: string
  plan: string
  status: string
  trialEndsAt?: string | null
  createdAt?: string
}

function daysRemaining(endDate: string | null | undefined): number | null {
  if (!endDate) return null
  const ms = new Date(endDate).getTime() - Date.now()
  if (ms <= 0) return 0
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

const STATUS_LABELS: Record<string, string> = {
  trialing: 'Trial',
  active: 'Active',
  suspended: 'Suspended',
  deleted: 'Deleted',
}

interface EntitlementInfo {
  hasEntitlement: boolean
  entitlementUsed: boolean
}

export default function HubDashboard() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [entitlement, setEntitlement] = useState<EntitlementInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fetchWorkspaces = useCallback(async () => {
    try {
      const [wsRes, entRes] = await Promise.all([
        fetch('/api/provisioning/workspace'),
        fetch('/api/auth/entitlement'),
      ])
      const wsData = await wsRes.json()
      if (wsData.workspaces) setWorkspaces(wsData.workspaces)
      if (entRes.ok) {
        const entData = await entRes.json()
        setEntitlement(entData)
      }
    } catch {
      // network error -- keep current list
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchWorkspaces()
  }, [fetchWorkspaces])

  const handleRename = async (id: string) => {
    setError('')
    if (!renameValue.trim()) return

    const res = await fetch(`/api/provisioning/workspace/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: renameValue.trim() }),
    })

    const data = await res.json()
    if (res.ok) {
      setRenamingId(null)
      setRenameValue('')
      fetchWorkspaces()
    } else {
      setError(data.error || 'Rename failed')
    }
  }

  const handleDelete = async (id: string) => {
    setError('')

    const res = await fetch(`/api/provisioning/workspace/${id}`, {
      method: 'DELETE',
    })

    const data = await res.json()
    if (res.ok) {
      setDeleteConfirm(null)
      fetchWorkspaces()
    } else {
      setError(data.error || 'Delete failed')
    }
  }

  const statusClass = (status: string) => {
    switch (status) {
      case 'active': return styles.statusActive
      case 'trialing': return styles.statusTrialing
      case 'suspended': return styles.statusSuspended
      default: return ''
    }
  }

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard}>
        <h1 className={styles.title}>Your Instances</h1>

        {loading ? (
          <p className={styles.emptyText}>Loading workspaces...</p>
        ) : (
          <>
            <ul className={styles.workspaceList}>
              {workspaces.map(workspace => (
                <li key={workspace.id} className={styles.workspaceItem}>
                  <div className={styles.workspaceInfo}>
                    {renamingId === workspace.id ? (
                      <div className={styles.renameRow}>
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className={styles.renameInput}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(workspace.id)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                        />
                        <button onClick={() => handleRename(workspace.id)} className={styles.saveBtn}>Save</button>
                        <button onClick={() => setRenamingId(null)} className={styles.cancelBtn}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <div className={styles.nameRow}>
                          <span className={styles.workspaceName}>{workspace.name}</span>
                          <span className={`${styles.statusBadge} ${statusClass(workspace.status)}`}>
                            {STATUS_LABELS[workspace.status] || workspace.status}
                          </span>
                        </div>
                        <span className={styles.workspaceTier}>
                          {workspace.subdomain}.{process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'} &middot; Plan: {workspace.plan}
                        </span>
                        {BILLING_ENABLED && workspace.status === 'trialing' && (
                          <span className={styles.trialHint}>
                            {daysRemaining(workspace.trialEndsAt) === 0
                              ? 'Trial expired — upgrade to continue'
                              : `Trial: ${daysRemaining(workspace.trialEndsAt)} day${daysRemaining(workspace.trialEndsAt) === 1 ? '' : 's'} remaining`
                            }
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div className={styles.actions}>
                    <a
                      href={`https://${workspace.subdomain}.${process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}`}
                      className={styles.launchButton}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Launch
                    </a>
                    {renamingId !== workspace.id && (
                      <>
                        <button
                          onClick={() => { setRenamingId(workspace.id); setRenameValue(workspace.name) }}
                          className={styles.actionBtn}
                          title="Rename"
                        >
                          Rename
                        </button>
                        {deleteConfirm === workspace.id ? (
                          <div className={styles.confirmRow}>
                            <span className={styles.confirmText}>Delete?</span>
                            <button onClick={() => handleDelete(workspace.id)} className={styles.confirmYes}>Yes</button>
                            <button onClick={() => setDeleteConfirm(null)} className={styles.confirmNo}>No</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(workspace.id)}
                            className={`${styles.actionBtn} ${styles.deleteBtn}`}
                            title="Delete"
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
              {workspaces.length === 0 && (
                <li className={styles.emptyText}>No instances found. Create one below!</li>
              )}
            </ul>
          </>
        )}

        {error && <p className={styles.errorBox}>{error}</p>}

        {!entitlement ? null : !entitlement.hasEntitlement && workspaces.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-lg)' }}>
            <p style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>
              You need an access code to create an instance.
            </p>
            <a
              href="/redeem"
              style={{
                display: 'inline-block',
                padding: 'var(--space-sm) var(--space-lg)',
                background: 'var(--color-accent)',
                color: 'white',
                borderRadius: 'var(--radius-md)',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Redeem Code
            </a>
          </div>
        ) : entitlement.hasEntitlement && workspaces.length > 0 ? (
          <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--color-text-muted)', padding: 'var(--space-md)' }}>
            You've already created your instance.
          </p>
        ) : showForm ? (
          <CreateInstanceForm onCreated={() => { setShowForm(false); fetchWorkspaces() }} />
        ) : (
          <button className={styles.createButton} onClick={() => setShowForm(true)}>
            + Create New Instance
          </button>
        )}
      </div>
    </div>
  )
}
