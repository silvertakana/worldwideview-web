'use client'

import React, { useEffect, useState } from 'react'
import { createClient } from '../../lib/supabase/client'
import styles from './hub.module.css'

interface Workspace {
  id: string
  name: string
  subdomain: string
  plan: string
}

export default function HubDashboard() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchWorkspaces = async () => {
      const supabase = createClient()
      // Changed 'Tenant' to 'workspaces' per Prisma schema mapping
      const { data, error } = await supabase.from('workspaces').select('*')
      if (data) {
        setWorkspaces(data)
      } else if (error) {
        console.error("Failed to load workspaces:", error)
      }
      setLoading(false)
    }
    fetchWorkspaces()
  }, [])

  return (
    <div className={styles.hubContainer}>
      <div className={styles.glassCard}>
        <h1 className={styles.title}>Your Workspaces</h1>
        
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading workspaces...</p>
        ) : (
          <ul className={styles.workspaceList}>
            {workspaces.map(workspace => (
              <li key={workspace.id} className={styles.workspaceItem}>
                <div className={styles.workspaceInfo}>
                  <span className={styles.workspaceName}>{workspace.name}</span>
                  <span className={styles.workspaceTier}>Plan: {workspace.plan}</span>
                </div>
                <a href={`https://${workspace.subdomain}.app.worldwideview.dev`} className={styles.launchButton}>
                  Launch
                </a>
              </li>
            ))}
            {workspaces.length === 0 && (
              <li style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 'var(--space-md)' }}>
                No workspaces found.
              </li>
            )}
          </ul>
        )}
        
        <button 
          className={styles.createButton} 
          onClick={() => alert('Provisioning to be implemented via Edge Function')}
        >
          + Create New Workspace
        </button>
      </div>
    </div>
  )
}
