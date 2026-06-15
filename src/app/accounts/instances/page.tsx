'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Server, Zap } from 'lucide-react'
import CreateInstanceForm from './CreateInstanceForm'
import styles from './instances.module.css'
import acctStyles from '../accounts.module.css'

interface Workspace {
  id: string
  name: string
  subdomain: string
  status: string
  createdAt?: string
}

interface AccountInfo {
  plan: string
  status: string
  trialEndsAt: string | null
  instanceCount: number
  instanceLimit: number
  isTrialing: boolean
  trialDaysRemaining: number | null
}

function daysRemaining(endDate: string | null | undefined): number | null {
  if (!endDate) return null
  const ms = new Date(endDate).getTime() - Date.now()
  if (ms <= 0) return 0
  return Math.ceil(ms / (1000 * 60 * 60 * 24))
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Suspended',
  deleted: 'Deleted',
}

export default function InstancesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fetchWorkspaces = useCallback(async () => {
    try {
      const res = await fetch('/api/provisioning/workspace')
      const data = await res.json()
      if (data.workspaces) setWorkspaces(data.workspaces)
      if (data.account) setAccount(data.account)
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

  const accountStatusClass = (status: string) => {
    switch (status) {
      case 'active': return styles.accountStatusActive
      case 'trialing': return styles.accountStatusTrialing
      case 'suspended': return styles.accountStatusSuspended
      default: return ''
    }
  }

  const accountPlanLabel = (plan: string) => {
    switch (plan) {
      case 'local': return 'Local'
      case 'pro': return 'Pro'
      case 'enterprise': return 'Enterprise'
      default: return plan
    }
  }

  const isSuspended = account?.status === 'suspended'
  const atInstanceLimit = account ? account.instanceCount >= account.instanceLimit : false
  const canCreate = !isSuspended && !atInstanceLimit

  const createButtonLabel = () => {
    if (isSuspended) return 'Account Suspended'
    if (atInstanceLimit) return 'Upgrade to Create More'
    return '+ Create New Instance'
  }

  return (
    <div className={acctStyles.pageContent}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-xl)' }}>
        <Server size={22} />
        <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 600 }}>Your Instances</h2>
      </div>

      {/* Account Plan Banner */}
      {account && !loading && (
        <div className={styles.accountBanner}>
          <div className={styles.accountBannerInfo}>
            <div className={styles.accountTierRow}>
              <Zap size={14} className={account.plan === 'local' ? styles.accountZapMuted : styles.accountZapAccent} />
              <span className={styles.accountPlanName}>{accountPlanLabel(account.plan)} Plan</span>
              {account.status !== 'local' && (
                <span className={`${styles.accountStatusBadge} ${accountStatusClass(account.status)}`}>
                  {account.status === 'trialing' ? 'Trial' : account.status === 'active' ? 'Active' : account.status === 'suspended' ? 'Suspended' : account.status}
                </span>
              )}
            </div>
            <span className={styles.accountInstanceCount}>
              {account.plan === 'local'
                ? 'Instances: Unlimited'
                : `Instances: ${account.instanceCount} / ${account.instanceLimit === Infinity ? 'Unlimited' : account.instanceLimit}`
              }
            </span>
            {account.isTrialing && account.trialDaysRemaining !== null && (
              <span className={`${styles.accountTrialText} ${account.trialDaysRemaining <= 0 ? styles.accountTrialExpired : ''}`}>
                {account.trialDaysRemaining <= 0
                  ? 'Trial expired -- upgrade to continue'
                  : `Trial: ${account.trialDaysRemaining} day${account.trialDaysRemaining === 1 ? '' : 's'} remaining`
                }
              </span>
            )}
            {isSuspended && (
              <span className={styles.accountSuspendedText}>
                Payment failed. Update your payment method to continue.
              </span>
            )}
          </div>
          <div className={styles.accountBannerAction}>
            {account.plan === 'local' ? (
              <a href="/signup?plan=pro" className={styles.accountUpgradeBtn}>
                Upgrade to Pro
              </a>
            ) : isSuspended ? (
              <a href="/accounts/billing" className={styles.accountUpdatePaymentBtn}>
                Update Payment
              </a>
            ) : (
              <a href="/accounts/billing" className={styles.accountManageBtn}>
                Manage Billing
              </a>
            )}
          </div>
        </div>
      )}

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
                        {workspace.subdomain}.{process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}
                      </span>
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

      {showForm ? (
        <CreateInstanceForm onCreated={() => { setShowForm(false); fetchWorkspaces() }} />
      ) : (
        <button
          className={`${styles.createButton} ${!canCreate ? styles.createButtonDisabled : ''}`}
          onClick={() => canCreate ? setShowForm(true) : undefined}
          disabled={isSuspended}
          title={isSuspended ? 'Account suspended -- update payment to create instances' : atInstanceLimit ? 'You\'ve reached the instance limit for your plan.' : ''}
        >
          {createButtonLabel()}
        </button>
      )}
      {isSuspended && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-danger, #ef4444)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          Account suspended -- update payment to create instances
        </p>
      )}
      {atInstanceLimit && !isSuspended && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          You've reached the instance limit for your plan.
        </p>
      )}
    </div>
  )
}
