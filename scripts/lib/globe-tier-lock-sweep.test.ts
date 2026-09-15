import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  TIER_LOCK_SWEEP_PATH,
  requireCrossServiceSecret,
  requestTierLockSweep,
} from './globe-tier-lock-sweep.mjs'

/**
 * The lock sweep is the one part of the reconciler that could change state on
 * the globe, so its two guarantees are pinned here: it refuses to run without
 * its secret, and it never sends a request it cannot justify.
 */

const ORIGINAL = process.env.CROSS_SERVICE_SECRET

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CROSS_SERVICE_SECRET
  else process.env.CROSS_SERVICE_SECRET = ORIGINAL
  vi.restoreAllMocks()
})

describe('requireCrossServiceSecret', () => {
  it('names the missing variable when it is absent', () => {
    delete process.env.CROSS_SERVICE_SECRET
    expect(() => requireCrossServiceSecret()).toThrow(/CROSS_SERVICE_SECRET is not set/)
  })

  it('says that adding it is a human step', () => {
    delete process.env.CROSS_SERVICE_SECRET
    expect(() => requireCrossServiceSecret()).toThrow(/human step/)
  })

  it('returns the secret when it is present', () => {
    process.env.CROSS_SERVICE_SECRET = 'test-secret'
    expect(requireCrossServiceSecret()).toBe('test-secret')
  })
})

describe('requestTierLockSweep', () => {
  it('fails on the missing secret rather than skipping the phase silently', async () => {
    delete process.env.CROSS_SERVICE_SECRET
    await expect(requestTierLockSweep({ emails: ['a@example.com'] })).rejects.toThrow(
      /CROSS_SERVICE_SECRET is not set/,
    )
  })

  it('refuses to send an unagreed payload even when the secret is present', async () => {
    process.env.CROSS_SERVICE_SECRET = 'test-secret'
    await expect(requestTierLockSweep({ emails: ['a@example.com'] })).rejects.toThrow(
      `POST ${TIER_LOCK_SWEEP_PATH} is not implemented`,
    )
  })

  it('never issues a network call, so no workspace can be locked by accident', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    process.env.CROSS_SERVICE_SECRET = 'test-secret'

    await expect(
      requestTierLockSweep({ emails: ['a@example.com', 'b@example.com'] }),
    ).rejects.toThrow(/NOT locked: a@example.com, b@example.com/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
