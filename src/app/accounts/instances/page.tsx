'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Server, Zap, Pencil, Trash2, Rocket, Key } from 'lucide-react'
import { BILLING_ENABLED } from '@/lib/billing/constants'
import CreateInstanceForm from './CreateInstanceForm'
import styles from './instances.module.css'
import acctStyles from '../accounts.module.css'

interface Workspace {
  id: string
  name: string
  subdomain: string
  status: string
  createdAt?: string
  setupCompleted?: boolean
  setupToken?: string
}

interface AccountInfo {
  tier: string
  plan: string
  status: string
  trialEndsAt: string | null
  instanceCount: number
  instanceLimit: number | null
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

interface EntitlementInfo {
  hasEntitlement: boolean
  entitlementUsed: boolean
}

export default function InstancesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [entitlement, setEntitlement] = useState<EntitlementInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteModal, setDeleteModal] = useState<Workspace | null>(null)
  const [deleteDeleting, setDeleteDeleting] = useState(false)
  const [deleteModalError, setDeleteModalError] = useState('')
  const [error, setError] = useState('')
  const [setupStates, setSetupStates] = useState<Record<string, boolean>>({})

  const fetchWorkspaces = useCallback(async () => {
    try {
      const [wsRes, entRes] = await Promise.all([
        fetch('/api/provisioning/workspace'),
        fetch('/api/auth/entitlement'),
      ])
      const wsData = await wsRes.json()
      const workspaces: Workspace[] = wsData.workspaces || []
      if (workspaces) setWorkspaces(workspaces)
      if (wsData.account) setAccount(wsData.account)
      if (entRes.ok) {
        const entData = await entRes.json()
        setEntitlement(entData)
      }

      // Fetch setup status for each workspace from the globe's status endpoint.
      // TODO: replace with batch endpoint when available. Falls back to Launch
      // if the per-instance /api/instance/{id}/status endpoint does not exist yet.
      const states: Record<string, boolean> = {}
      await Promise.allSettled(
        workspaces.map(async (ws: Workspace) => {
          try {
            const res = await fetch(`/api/provisioning/workspace/${ws.id}/status`)
            if (res.ok) {
              const data = await res.json()
              states[ws.id] = data.setupCompleted === true
            } else if (res.status === 404) {
              // status endpoint not implemented yet -- default to completed
              states[ws.id] = true
            } else {
              states[ws.id] = true
            }
          } catch {
            states[ws.id] = true
          }
        }),
      )
      setSetupStates(states)
    } catch {
      // network error -- keep current list
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchWorkspaces()
  }, [fetchWorkspaces])

  // Poll for account after successful checkout redirect (webhook may not have fired yet)
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get('checkout')
    if (checkout === 'success' && !account && !loading) {
      const interval = setInterval(() => fetchWorkspaces(), 2000)
      // Stop after 30 seconds to avoid indefinite polling
      const timeout = setTimeout(() => clearInterval(interval), 30000)
      return () => { clearInterval(interval); clearTimeout(timeout) }
    }
  }, [account, loading, fetchWorkspaces])

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
    setDeleteModalError('')
    setDeleteDeleting(true)

    const res = await fetch(`/api/provisioning/workspace/${id}`, {
      method: 'DELETE',
    })

    const data = await res.json()
    setDeleteDeleting(false)
    if (res.ok) {
      setDeleteModal(null)
      fetchWorkspaces()
    } else {
      setDeleteModalError(data.error || 'Delete failed')
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
      case 'free': return 'Local'
      case 'beta_tester': return 'Beta Tester'
      case 'early_access': return 'Early Access'
      case 'pro': return 'Pro'
      case 'enterprise': return 'Enterprise'
      default: return plan
    }
  }

  const isSuspended = account?.status === 'suspended'
  const isDeleted = account?.status === 'deleted'
  const atInstanceLimit = account ? account.instanceLimit !== null && account.instanceCount >= account.instanceLimit : false
  const needsEntitlement = !entitlement || !entitlement.hasEntitlement
  const entitlementAlreadyUsed = entitlement?.entitlementUsed
  const canCreate = !isSuspended && !isDeleted && !atInstanceLimit && !needsEntitlement && !entitlementAlreadyUsed

  const createButtonLabel = () => {
    if (isSuspended) return 'Account Suspended'
    if (isDeleted) return 'Account Deleted'
    if (atInstanceLimit && !BILLING_ENABLED) return 'Instance limit reached'
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
              {account.tier !== 'free' && (
                <span className={`${styles.accountStatusBadge} ${accountStatusClass(account.status)}`}>
                  {account.status === 'trialing' ? 'Trial' : account.status === 'active' ? 'Active' : account.status === 'suspended' ? 'Suspended' : account.status}
                </span>
              )}
            </div>
            <span className={styles.accountInstanceCount}>
              Instances: {account.instanceCount} / {account.instanceLimit === null || account.instanceLimit === Infinity ? 'Unlimited' : account.instanceLimit}
            </span>
            {BILLING_ENABLED && account.isTrialing && account.trialDaysRemaining !== null && (
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
            {isDeleted && !isSuspended && (
              <span className={styles.accountSuspendedText}>
                Account deleted. Contact support to reactivate your subscription.
              </span>
            )}
          </div>
          <div className={styles.accountBannerAction}>
            {account.tier === 'free' ? (
              <a href="/accounts/redeem" className={styles.accountUpgradeBtn}>
                Redeem Code
              </a>
            ) : ['beta_tester', 'early_access'].includes(account.tier) ? (
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                Access code active
              </span>
            ) : isSuspended ? (
              <a href="/accounts/billing" className={styles.accountUpdatePaymentBtn}>
                Update Payment
              </a>
            ) : isDeleted ? (
              <a href="mailto:support@worldwideview.dev" className={styles.accountManageBtn}>{/* lint-url: allow */}Contact Support</a>
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
                        {setupStates[workspace.id] === false && (
                          <span className={`${styles.statusBadge} ${styles.setupBadge}`}>
                            Needs setup
                          </span>
                        )}
                      </div>
                      <span className={styles.workspaceTier}>
                        {workspace.subdomain}.{process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}
                      </span>
                    </>
                  )}
                </div>

                <div className={styles.actions}>
                  {renamingId !== workspace.id && (
                    <>
                      <button
                        onClick={() => { setRenamingId(workspace.id); setRenameValue(workspace.name) }}
                        className={`${styles.iconBtn} ${styles.iconBtnRename}`}
                        data-tooltip="Rename"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => setDeleteModal(workspace)}
                        className={`${styles.iconBtn} ${styles.iconBtnDelete}`}
                        data-tooltip="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                  {setupStates[workspace.id] === false ? (
                    <a
                      href={`https://${workspace.subdomain}.${process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}/setup${workspace.setupToken ? `?token=${workspace.setupToken}` : ''}`}
                      className={`${styles.iconBtn} ${styles.iconBtnSetup}`}
                      data-tooltip="Set up"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Key size={16} />
                    </a>
                  ) : (
                    <a
                      href={`https://${workspace.subdomain}.${process.env.NEXT_PUBLIC_WORKSPACE_DOMAIN || 'cloud-wwv.dev'}`}
                      className={`${styles.iconBtn} ${styles.iconBtnLaunch}`}
                      data-tooltip="Launch"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Rocket size={16} />
                    </a>
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

      {/* Delete Confirmation Modal */}
      {deleteModal && (
        <div className={styles.modalOverlay} onClick={() => !deleteDeleting && setDeleteModal(null)}>
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete &ldquo;{deleteModal.name}&rdquo;?</h3>
            <p className={styles.modalBody}>
              This will permanently delete this instance and all its data.
            </p>
            {deleteModalError && <p className={styles.modalError}>{deleteModalError}</p>}
            <div className={styles.modalButtons}>
              <button
                className={styles.modalDeleteBtn}
                onClick={() => handleDelete(deleteModal.id)}
                disabled={deleteDeleting}
              >
                {deleteDeleting ? 'Deleting...' : 'Delete'}
              </button>
              <button
                className={styles.modalCancelBtn}
                onClick={() => setDeleteModal(null)}
                disabled={deleteDeleting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {needsEntitlement && workspaces.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-xl)' }}>
          <p style={{ fontSize: '0.95rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>
            You need an access code to create an instance.
          </p>
          <a
            href="/accounts/redeem"
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
      ) : entitlementAlreadyUsed && workspaces.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-xl)' }}>
          <p style={{ fontSize: '0.95rem', color: 'var(--color-text-muted)' }}>
            You've already created your instance.
          </p>
        </div>
      ) : showForm ? (
        <CreateInstanceForm onCreated={() => { setShowForm(false); fetchWorkspaces() }} />
      ) : (
        <button
          className={`${styles.createButton} ${!canCreate ? styles.createButtonDisabled : ''}`}
          onClick={() => canCreate ? setShowForm(true) : undefined}
          disabled={isSuspended || isDeleted}
          title={isSuspended ? 'Account suspended -- update payment to create instances' : isDeleted ? 'Account deleted' : atInstanceLimit ? 'You\'ve reached the instance limit for your plan.' : ''}
        >
          {createButtonLabel()}
        </button>
      )}
      {isSuspended && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-danger, #ef4444)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          Account suspended -- update payment to create instances
        </p>
      )}
      {isDeleted && !isSuspended && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-danger, #ef4444)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          Account deleted -- contact support to reactivate your subscription.
        </p>
      )}
      {atInstanceLimit && !isSuspended && !isDeleted && BILLING_ENABLED && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          You've reached the instance limit for your plan.
        </p>
      )}
      {atInstanceLimit && !isSuspended && !isDeleted && !BILLING_ENABLED && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', textAlign: 'center', marginTop: 'var(--space-sm)' }}>
          Instance limit reached. Billing is not available during the beta period.
        </p>
      )}
    </div>
  )
}
