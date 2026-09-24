import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const { mockGetUser, mockInsert, mockUpdate, mockRevalidatePath } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockRevalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: () => ({ insert: mockInsert }),
  }),
}))

// The real module imports 'server-only', which throws outside a React server.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ update: mockUpdate }) }),
}))

import { generateCodes, updateCode } from './actions'
import { CODE_TIERS, CODE_TIERS_HELP, DEFAULT_CODE_TIER } from '@/lib/billing/code-tiers'

// Mirrors CODE_CHARS in ./actions.ts. It cannot be imported: a 'use server'
// module may only export async functions and generateCodeSegment is private.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_PATTERN = new RegExp(`^WWV-[${ALPHABET}]{5}-[${ALPHABET}]{5}$`)

const ADMIN = { id: 'admin_1', app_metadata: { role: 'admin' } }

beforeEach(() => {
  mockGetUser.mockReset()
  mockInsert.mockReset()
  mockUpdate.mockReset()
  mockRevalidatePath.mockReset()

  mockGetUser.mockResolvedValue({ data: { user: ADMIN } })
  mockInsert.mockResolvedValue({ error: null })
  // update() returns a chain; the awaited tail resolves the write result.
  mockUpdate.mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
})

describe('generateCodes', () => {
  it('produces the exact WWV-XXXXX-XXXXX format, with no ambiguous glyphs', async () => {
    const { codes, error } = await generateCodes(50, 30, '')

    expect(error).toBeUndefined()
    expect(codes).toHaveLength(50)
    for (const code of codes) {
      expect(code).toMatch(CODE_PATTERN)
    }
    // The alphabet excludes the ambiguous glyphs I, L, O, 0 and 1.
    expect(codes.join('')).not.toMatch(/[ILO01]/)
  })

  it('draws from every position of the alphabet, so no character is starved', async () => {
    // 310 codes = 620 segments = 3100 draws over 31 positions, so each position
    // is expected about 100 times. A position that can never be selected would
    // be visible here; the chance of missing a reachable position is
    // (30/31)^3100, roughly 4e-44, so this is deterministic in practice.
    const { codes } = await generateCodes(310, 30, '')

    const counts = new Map<string, number>()
    for (const char of codes.join('').replace(/WWV-/g, '').replace(/-/g, '')) {
      counts.set(char, (counts.get(char) ?? 0) + 1)
    }

    expect(counts.size).toBe(ALPHABET.length)
    expect([...counts.keys()].sort().join('')).toBe([...ALPHABET].sort().join(''))
  })

  it('indexes the alphabet directly with randomInt instead of folding randomBytes', () => {
    // The defect cannot be exercised behaviourally: vitest externalises node
    // builtins, so vi.mock('crypto') and vi.mock('node:crypto') are both
    // bypassed and the draw cannot be scripted. A statistical bias test would be
    // slow and could flake, so pin the mechanism instead. `randomBytes(5)[i] %
    // CODE_CHARS.length` folded 256 byte values into 31 buckets; because
    // 256 = 8 * 31 + 8, indices 0..7 were reachable from 9 byte values and
    // indices 8..30 from only 8, over-representing 'A'..'H' by about 9.0%.
    const source = readFileSync(
      path.join(process.cwd(), 'src/app/admin/codes/actions.ts'),
      'utf-8',
    ).replace(/^\s*\/\/.*$/gm, '')

    expect(source).toMatch(/CODE_CHARS\[randomInt\(0, CODE_CHARS\.length\)\]/)
    expect(source).not.toContain('randomBytes')
    expect(source).not.toMatch(/%\s*CODE_CHARS\.length/)
    // The arithmetic behind the bias, kept alongside the guard above.
    expect(256 % ALPHABET.length).toBe(8)
    expect(ALPHABET.length).toBe(31)
  })
})

// ── the tier restriction ────────────────────────────────────────────
//
// The hole this closes was not theoretical. Nothing validated the tier, so a
// caller could mint a code for beta_tester or early_access - tiers the globe's
// tier-sync does not accept (globe-tiers.ts) and that rank BELOW pro - and every
// redemption of such a code recorded an entitlement the globe could never
// mirror. The customer's access existed on paper only.
describe('generateCodes tier restriction', () => {
  it.each([
    ['a hub-only tier that ranks below pro', 'beta_tester'],
    ['the other hub-only tier', 'early_access'],
    ['the free tier', 'free'],
    ['an unknown string', 'superuser'],
    ['an empty string', ''],
  ])('refuses to mint a code for %s', async (_label, tier) => {
    const { codes, error } = await generateCodes(1, 30, 'launch', tier)

    expect(codes).toEqual([])
    expect(error).toBe(CODE_TIERS_HELP)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('mints a code for every tier it offers', async () => {
    for (const tier of CODE_TIERS) {
      mockInsert.mockClear()

      const { codes, error } = await generateCodes(2, 30, '', tier)

      expect(error).toBeUndefined()
      expect(codes).toHaveLength(2)
      expect(mockInsert).toHaveBeenCalledWith([
        expect.objectContaining({ tier, max_uses: 1, grants_days: 30 }),
        expect.objectContaining({ tier, max_uses: 1, grants_days: 30 }),
      ])
    }
  })

  it('defaults to a tier the globe accepts when the caller passes none', async () => {
    const { error } = await generateCodes(1, 30, '')

    expect(error).toBeUndefined()
    expect(mockInsert).toHaveBeenCalledWith([expect.objectContaining({ tier: DEFAULT_CODE_TIER })])
  })

  it('still refuses an unauthorized caller', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user_1', app_metadata: {} } } })

    const { codes, error } = await generateCodes(1, 30, '', 'beta_tester')

    expect(codes).toEqual([])
    expect(error).toBe('Unauthorized')
    expect(mockInsert).not.toHaveBeenCalled()
  })
})

describe('updateCode tier restriction', () => {
  it('refuses to move an existing code onto a tier the globe rejects', async () => {
    const result = await updateCode('code_1', { tier: 'beta_tester' })

    expect(result).toEqual({ success: false, error: CODE_TIERS_HELP })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('allows a valid tier change', async () => {
    const result = await updateCode('code_1', { tier: 'enterprise' })

    expect(result).toEqual({ success: true })
    expect(mockUpdate).toHaveBeenCalledWith({ tier: 'enterprise' })
  })

  it('still allows a notes-only edit of a legacy row', async () => {
    // Rows issued before the restriction exist, and they must stay editable:
    // blocking them would leave an operator unable to annotate or expire the very
    // codes this change is cleaning up.
    const result = await updateCode('code_1', { notes: 'legacy row, do not reissue' })

    expect(result).toEqual({ success: true })
    expect(mockUpdate).toHaveBeenCalledWith({ notes: 'legacy row, do not reissue' })
  })
})
