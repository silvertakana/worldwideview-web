'use client'

import { useState } from 'react'
import {
  CODE_TIERS,
  CODE_TIERS_HELP,
  DEFAULT_CODE_TIER,
  codeTierLabel,
} from '@/lib/billing/code-tiers'
import { generateCodes } from './actions'
import styles from './GenerateForm.module.css'

export function GenerateForm() {
  const [codes, setCodes] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSubmit(formData: FormData) {
    setPending(true)
    setError('')
    setCodes(null)

    const quantity = Math.min(Math.max(Number(formData.get('quantity') ?? 1), 1), 100)
    const grantsDays = Math.max(Number(formData.get('grantsDays') ?? 30), 1)
    const notes = String(formData.get('notes') ?? '')
    const tier = String(formData.get('tier') ?? DEFAULT_CODE_TIER)

    const result = await generateCodes(quantity, grantsDays, notes, tier)
    if (result.error) {
      setError(result.error)
    } else {
      setCodes(result.codes)
    }
    setPending(false)
  }

  async function copyAll() {
    if (codes) {
      await navigator.clipboard.writeText(codes.join('\n'))
    }
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Generate Access Codes</h2>

      <form action={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="quantity" className={styles.label}>Quantity</label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            max={100}
            defaultValue={1}
            className={styles.input}
            required
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="grantsDays" className={styles.label}>Grant Days</label>
          <input
            id="grantsDays"
            name="grantsDays"
            type="number"
            min={1}
            defaultValue={30}
            className={styles.input}
            required
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="tier" className={styles.label}>Tier</label>
          {/* Only tiers the globe's tier-sync accepts are offered: anything else
              redeems into a grant the globe refuses, so the customer gets a hub
              row and no access. See src/lib/billing/code-tiers.ts. */}
          <select
            id="tier"
            name="tier"
            className={styles.input}
            defaultValue={DEFAULT_CODE_TIER}
          >
            {CODE_TIERS.map(tier => (
              <option key={tier} value={tier}>{codeTierLabel(tier)}</option>
            ))}
          </select>
          <p className={styles.hint}>{CODE_TIERS_HELP}</p>
        </div>

        <div className={styles.field}>
          <label htmlFor="notes" className={styles.label}>Notes</label>
          <input
            id="notes"
            name="notes"
            type="text"
            className={styles.input}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className={styles.button}
        >
          {pending ? 'Generating...' : 'Generate Codes'}
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}

      {codes && codes.length > 0 && (
        <div className={styles.results}>
          <div className={styles.resultsHeader}>
            <h3 className={styles.resultsHeading}>
              Generated Codes ({codes.length})
            </h3>
            <button onClick={copyAll} className={styles.copyAllButton}>
              Copy All
            </button>
          </div>
          <ul className={styles.codeList}>
            {codes.map(code => (
              <li key={code} className={styles.codeItem}>
                <code className={styles.code}>{code}</code>
                <button
                  onClick={() => navigator.clipboard.writeText(code)}
                  className={styles.copyButton}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
