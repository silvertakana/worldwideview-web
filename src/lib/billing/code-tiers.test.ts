import { describe, it, expect } from 'vitest'
import {
  CODE_TIERS,
  CODE_TIERS_HELP,
  DEFAULT_CODE_TIER,
  codeTierLabel,
  isCodeTier,
} from './code-tiers'
import { GLOBE_TIERS } from './globe-tiers'

/**
 * The invariant these tests exist for: a code minted from CODE_TIERS can always
 * be pushed to the globe. A code granting a tier the globe's tier-sync does not
 * accept redeems into an entitlement row and no access, and the failure is
 * invisible on both sides until the customer complains.
 */
describe('CODE_TIERS', () => {
  it('offers only tiers the globe accepts', () => {
    for (const tier of CODE_TIERS) {
      expect(GLOBE_TIERS).toContain(tier)
    }
  })

  it('leaves out the two hub-only tiers that the globe cannot express', () => {
    // Ranking both BELOW pro is the tell: TIER_RANK (tier-rank.ts) puts
    // beta_tester at 1 and early_access at 2, under pro's 3. Pushing either to
    // the globe would have to be invented, and globe-tiers.ts already calls that
    // "a silent lie" - the globe would report a tier the hub does not believe.
    expect(CODE_TIERS).not.toContain('beta_tester')
    expect(CODE_TIERS).not.toContain('early_access')
  })

  it('does not offer a code that grants the free tier', () => {
    expect(CODE_TIERS).not.toContain('free')
  })

  it('deliberately omits team, which is a product decision and not a bug', () => {
    // team IS globe-accepted. It is absent because it was never offered by the
    // generator, and widening the list grants access nobody asked for. If this
    // test fails, whoever added it should mean it.
    expect(GLOBE_TIERS).toContain('team')
    expect(CODE_TIERS).not.toContain('team')
  })

  it('is never empty, so the generator always has something valid to fall back to', () => {
    expect(CODE_TIERS.length).toBeGreaterThan(0)
    expect(CODE_TIERS).toContain(DEFAULT_CODE_TIER)
  })
})

describe('isCodeTier', () => {
  it('accepts every tier the list offers', () => {
    for (const tier of CODE_TIERS) {
      expect(isCodeTier(tier)).toBe(true)
    }
  })

  it('rejects the tiers that would produce a grant the globe never honours', () => {
    expect(isCodeTier('beta_tester')).toBe(false)
    expect(isCodeTier('early_access')).toBe(false)
    expect(isCodeTier('free')).toBe(false)
  })

  it('rejects anything that is not one of its own values', () => {
    // A server action is a public endpoint, so this is the guard that stands
    // between a caller and an arbitrary string in access_codes.tier.
    expect(isCodeTier('')).toBe(false)
    expect(isCodeTier('PRO')).toBe(false)
    expect(isCodeTier('pro ')).toBe(false)
    expect(isCodeTier('admin')).toBe(false)
    expect(isCodeTier("pro'--")).toBe(false)
  })
})

describe('the operator-facing text', () => {
  it('names every accepted tier in the message the form shows', () => {
    for (const tier of CODE_TIERS) {
      expect(CODE_TIERS_HELP).toContain(tier)
    }
  })

  it('labels a tier for a person', () => {
    expect(codeTierLabel('pro')).toBe('Pro')
    expect(codeTierLabel('enterprise')).toBe('Enterprise')
    // Legacy values still render, because CodesTable shows rows that predate the
    // restriction and must not display them as blank.
    expect(codeTierLabel('beta_tester')).toBe('Beta Tester')
  })
})
