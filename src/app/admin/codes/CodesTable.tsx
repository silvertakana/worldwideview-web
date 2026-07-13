'use client'

import { useState, useMemo } from 'react'
import {
  revokeCode,
  updateCode,
  unrevokeCode,
  deleteCode,
  bulkRevokeCodes,
  bulkUnrevokeCodes,
  bulkDeleteCodes,
} from './actions'
import styles from './CodesTable.module.css'
import type { AccessCode } from './page'

const TIERS = ['beta_tester', 'early_access', 'pro', 'enterprise'] as const
const STATUS_FILTERS = ['all', 'available', 'revoked', 'expired', 'redeemed'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

function getStatus(code: AccessCode): { label: string; className: string } {
  if (code.revoked_at) return { label: 'Revoked', className: styles.statusRevoked }
  if (code.expires_at && new Date(code.expires_at) < new Date())
    return { label: 'Expired', className: styles.statusExpired }
  if (code.use_count >= code.max_uses)
    return { label: 'Redeemed', className: styles.statusRedeemed }
  return { label: 'Available', className: styles.statusAvailable }
}

export function CodesTable({ codes }: { codes: AccessCode[] }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tierFilter, setTierFilter] = useState('all')
  const [sortField, setSortField] = useState<'created_at' | 'code' | 'grants_days' | 'tier' | 'use_count'>('created_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editData, setEditData] = useState<{ grants_days: number; max_uses: number; tier: string; notes: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)

  const filteredAndSorted = useMemo(() => {
    let result = [...codes]
    if (statusFilter !== 'all') {
      result = result.filter(code => getStatus(code).label.toLowerCase() === statusFilter)
    }
    if (tierFilter !== 'all') {
      result = result.filter(code => code.tier === tierFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        code => code.code.toLowerCase().includes(q) || (code.notes || '').toLowerCase().includes(q),
      )
    }
    result.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'created_at':
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
        case 'code':
          cmp = a.code.localeCompare(b.code)
          break
        case 'grants_days':
          cmp = a.grants_days - b.grants_days
          break
        case 'tier':
          cmp = (a.tier || '').localeCompare(b.tier || '')
          break
        case 'use_count':
          cmp = a.use_count - b.use_count
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return result
  }, [codes, statusFilter, tierFilter, searchQuery, sortField, sortDir])

  const allVisibleSelected = filteredAndSorted.length > 0 && filteredAndSorted.every(c => selectedIds.has(c.id))
  const hasRevokedSelected = filteredAndSorted.some(c => selectedIds.has(c.id) && c.revoked_at)

  function handleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredAndSorted.map(c => c.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startEdit(code: AccessCode) {
    setEditingId(code.id)
    setEditData({ grants_days: code.grants_days, max_uses: code.max_uses, tier: code.tier, notes: code.notes || '' })
    setEditError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditData(null)
    setEditError('')
  }

  async function handleSave() {
    if (!editingId || !editData) return
    setSaving(true)
    setEditError('')
    const result = await updateCode(editingId, {
      grants_days: editData.grants_days,
      max_uses: editData.max_uses,
      tier: editData.tier,
      notes: editData.notes,
    })
    if (result.error) {
      setEditError(result.error)
      setSaving(false)
    } else {
      setEditingId(null)
      setEditData(null)
      setSaving(false)
    }
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  async function doRevoke(codeId: string) {
    if (!confirm('Revoke this access code? It can no longer be used.')) return
    setActionLoading(prev => new Set(prev).add(codeId))
    await revokeCode(codeId)
    setActionLoading(prev => { const n = new Set(prev); n.delete(codeId); return n })
  }

  async function doUnrevoke(codeId: string) {
    setActionLoading(prev => new Set(prev).add(codeId))
    await unrevokeCode(codeId)
    setActionLoading(prev => { const n = new Set(prev); n.delete(codeId); return n })
  }

  async function doDelete(codeId: string) {
    if (!confirm('Permanently delete this access code? This cannot be undone.')) return
    setActionLoading(prev => new Set(prev).add(codeId))
    await deleteCode(codeId)
    setActionLoading(prev => { const n = new Set(prev); n.delete(codeId); return n })
  }

  async function doBulkRevoke() {
    if (!confirm(`Revoke ${selectedIds.size} access codes? They can no longer be used.`)) return
    setBulkLoading(true)
    await bulkRevokeCodes(Array.from(selectedIds))
    setSelectedIds(new Set())
    setBulkLoading(false)
  }

  async function doBulkUnrevoke() {
    setBulkLoading(true)
    await bulkUnrevokeCodes(Array.from(selectedIds))
    setSelectedIds(new Set())
    setBulkLoading(false)
  }

  async function doBulkDelete() {
    if (!confirm(`Permanently delete ${selectedIds.size} access codes? This cannot be undone.`)) return
    setBulkLoading(true)
    await bulkDeleteCodes(Array.from(selectedIds))
    setSelectedIds(new Set())
    setBulkLoading(false)
  }

  function renderSortIcon(field: typeof sortField) {
    if (sortField !== field) return null
    return <span className={styles.sortIcon}>{sortDir === 'asc' ? ' \u25B2' : ' \u25BC'}</span>
  }

  const s = styles;

  return (
    <div className={s.container}>
      <h2 className={s.heading}>Access Codes</h2>
      <div className={s.filterRow}>
        <input type="text" placeholder="Search codes or notes..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className={s.searchInput} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)} className={s.filterSelect}>
          {STATUS_FILTERS.map(f => (
            <option key={f} value={f}>{f === 'all' ? 'All Statuses' : f.charAt(0).toUpperCase() + f.slice(1)}</option>
          ))}
        </select>
        <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} className={s.filterSelect}>
          <option value="all">All Tiers</option>
          {TIERS.map(t => (<option key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>))}
        </select>
      </div>
      {selectedIds.size > 0 && (
        <div className={s.bulkBar}>
          <span className={s.bulkBarText}>{selectedIds.size} selected</span>
          <button onClick={doBulkRevoke} disabled={bulkLoading} className={s.bulkActionButton}>Revoke Selected</button>
          {hasRevokedSelected && <button onClick={doBulkUnrevoke} disabled={bulkLoading} className={`${s.bulkActionButton} ${s.unrevokeButton}`}>Unrevoke Selected</button>}
          <button onClick={doBulkDelete} disabled={bulkLoading} className={`${s.bulkActionButton} ${s.deleteButton}`}>Delete Selected</button>
          <button onClick={() => setSelectedIds(new Set())} className={s.clearSelection}>Clear selection</button>
        </div>
      )}
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th className={s.checkboxCell}><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} className={s.checkbox} /></th>
              <th className={`${s.sortable} ${sortField === 'code' ? s.sortActive : ''}`} onClick={() => handleSort('code')}>Code{renderSortIcon('code')}</th>
              <th>Status</th>
              <th className={`${s.sortable} ${sortField === 'grants_days' ? s.sortActive : ''}`} onClick={() => handleSort('grants_days')}>Days{renderSortIcon('grants_days')}</th>
              <th className={`${s.sortable} ${sortField === 'tier' ? s.sortActive : ''}`} onClick={() => handleSort('tier')}>Tier{renderSortIcon('tier')}</th>
              <th className={`${s.sortable} ${sortField === 'use_count' ? s.sortActive : ''}`} onClick={() => handleSort('use_count')}>Uses{renderSortIcon('use_count')}</th>
              <th>Notes</th>
              <th className={`${s.sortable} ${sortField === 'created_at' ? s.sortActive : ''}`} onClick={() => handleSort('created_at')}>Created{renderSortIcon('created_at')}</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSorted.length === 0 ? (
              <tr><td colSpan={9} className={s.empty}>{codes.length === 0 ? 'No access codes yet.' : 'No codes match your filters.'}</td></tr>
            ) : (
              filteredAndSorted.map(code => {
                const isEditing = editingId === code.id;
                const isLoading = actionLoading.has(code.id);
                const status = getStatus(code);
                return (
                  <tr key={code.id} className={isEditing ? s.editingRow : undefined}>
                    <td className={s.checkboxCell}><input type="checkbox" checked={selectedIds.has(code.id)} onChange={() => toggleSelect(code.id)} className={s.checkbox} /></td>
                    <td className={s.codeCell}><code>{code.code}</code></td>
                    <td><span className={`${s.status} ${status.className}`}>{status.label}</span></td>
                    <td>{isEditing ? (
                      <input type="number" min={1} value={editData!.grants_days} onChange={e => setEditData(d => d ? {...d, grants_days: Math.max(1, parseInt(e.target.value) || 1)} : null)} onKeyDown={handleEditKeyDown} className={s.editInput} autoFocus />
                    ) : (
                      <span className={s.editable} onClick={() => startEdit(code)} title="Click to edit">{code.grants_days}</span>
                    )}</td>
                    <td>{isEditing ? (
                      <select value={editData!.tier} onChange={e => setEditData(d => d ? {...d, tier: e.target.value} : null)} onKeyDown={handleEditKeyDown} className={s.editSelect}>
                        {TIERS.map(t => (<option key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>))}
                      </select>
                    ) : (
                      <span className={s.editable} onClick={() => startEdit(code)} title="Click to edit">{code.tier}</span>
                    )}</td>
                    <td>{isEditing ? (
                      <input type="number" min={1} value={editData!.max_uses} onChange={e => setEditData(d => d ? {...d, max_uses: Math.max(1, parseInt(e.target.value) || 1)} : null)} onKeyDown={handleEditKeyDown} className={s.editInput} />
                    ) : (
                      <span>{code.use_count}/<span className={s.editable} onClick={() => startEdit(code)} title="Click to edit max uses">{code.max_uses}</span></span>
                    )}</td>
                    <td>{isEditing ? (
                      <input type="text" value={editData!.notes} onChange={e => setEditData(d => d ? {...d, notes: e.target.value} : null)} onKeyDown={handleEditKeyDown} className={s.editInput} />
                    ) : (
                      <span className={`${s.notesCell} ${s.editable}`} onClick={() => startEdit(code)} title="Click to edit">{code.notes || '-'}</span>
                    )}</td>
                    <td>{new Date(code.created_at).toLocaleDateString()}</td>
                    <td className={s.actionsCell}>
                      {isEditing ? (
                        <div className={s.editActions}>
                          <button onClick={handleSave} disabled={saving} className={s.saveButton}>{saving ? 'Saving...' : 'Save'}</button>
                          <button onClick={cancelEdit} disabled={saving} className={s.cancelButton}>Cancel</button>
                          {editError && <span className={s.editError}>{editError}</span>}
                        </div>
                      ) : (
                        <div className={s.actionButtons}>
                          {!code.revoked_at ? (
                            <button onClick={() => doRevoke(code.id)} disabled={isLoading} className={s.revokeButton}>{isLoading ? '...' : 'Revoke'}</button>
                          ) : (
                            <button onClick={() => doUnrevoke(code.id)} disabled={isLoading} className={`${s.revokeButton} ${s.unrevokeButton}`}>{isLoading ? '...' : 'Unrevoke'}</button>
                          )}
                          <button onClick={() => startEdit(code)} disabled={isLoading} className={s.editButton}>Edit</button>
                          <button onClick={() => doDelete(code.id)} disabled={isLoading} className={`${s.revokeButton} ${s.deleteButton}`}>Delete</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
