'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { createClient } from '../../lib/supabase/client'
import CreateWorkspaceForm from './CreateWorkspaceForm'
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

export default function HubDashboard() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fetchWorkspaces = useCallback(async () => {
    const supabase = createClient()
    const { data } = await supabase.from('workspaces').select('*')
    if (data) setWorkspaces(data)
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
        <h1 className={styles.title}>Your Workspaces</h1>

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
                          {workspace.subdomain}.cloud-wwv.dev &middot; Plan: {workspace.plan}
                        </span>
                        {workspace.status === 'trialing' && (
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
                      href={`https://${workspace.subdomain}.cloud-wwv.dev`}
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
                <li className={styles.emptyText}>No workspaces found. Create one below!</li>
              )}
            </ul>
          </>
        )}

        {error && <p className={styles.errorBox}>{error}</p>}

        {showForm ? (
          <CreateWorkspaceForm onCreated={() => { setShowForm(false); fetchWorkspaces() }} />
        ) : (
          <button className={styles.createButton} onClick={() => setShowForm(true)}>
            + Create New Workspace
          </button>
        )}
      </div>
    </div>
  )
}
