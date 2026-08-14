import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createHash } from 'node:crypto'
import { DICEBEAR_BASE, diceBearUrl } from './diceBear'
import { useDiceBearUrl } from './useDiceBearUrl'

const SEED = 'Quick Verify Tester'

function seedOf(url: string): string {
  const match = url.match(/[?&]seed=([0-9a-f]+)/)
  return match ? match[1] : ''
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('diceBearUrl', () => {
  it('is deterministic for the same seed', async () => {
    const a = await diceBearUrl(SEED)
    const b = await diceBearUrl(SEED)
    expect(a).toBe(b)
  })

  it('differs for different seeds', async () => {
    const a = await diceBearUrl(SEED)
    const b = await diceBearUrl('Somebody Else')
    expect(a).not.toBe(b)
  })

  it('hashes the seed with SHA-256 (no raw PII in the URL)', async () => {
    const email = 'quickverify@worldwideview.local'
    const url = await diceBearUrl(email)
    expect(url.startsWith(DICEBEAR_BASE)).toBe(true)
    expect(seedOf(url)).toBe(sha256Hex(email))
    expect(url).not.toContain(email)
    expect(url).not.toContain('quickverify')
  })

  it('falls back to a synchronous hash when crypto.subtle is unavailable (non-secure context)', async () => {
    // Simulate a non-secure context (LAN/IP HTTP): no Web Crypto at all.
    vi.stubGlobal('crypto', {} as Crypto)
    const url = await diceBearUrl(SEED)
    expect(url.startsWith(DICEBEAR_BASE)).toBe(true)
    expect(seedOf(url)).toMatch(/^[0-9a-f]{8}$/)
    expect(url).not.toContain(SEED)
  })

  it('does not hang when crypto.subtle rejects mid-hash', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: () => Promise.reject(new Error('NotAllowedError')),
      },
    } as unknown as Crypto)
    const url = await diceBearUrl(SEED)
    expect(url.startsWith(DICEBEAR_BASE)).toBe(true)
    expect(seedOf(url)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('useDiceBearUrl', () => {
  it('returns null for a null seed', () => {
    const { result } = renderHook(() => useDiceBearUrl(null))
    expect(result.current).toBeNull()
  })

  it('returns null for an empty seed', () => {
    const { result } = renderHook(() => useDiceBearUrl(''))
    expect(result.current).toBeNull()
  })

  it('resolves a dicebear URL for a real seed', async () => {
    const { result } = renderHook(() => useDiceBearUrl(SEED))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current!.startsWith(DICEBEAR_BASE)).toBe(true)
    expect(seedOf(result.current!)).toBe(sha256Hex(SEED))
  })
})
