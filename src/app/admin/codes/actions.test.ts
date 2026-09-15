import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const { mockGetUser, mockInsert, mockRevalidatePath } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockInsert: vi.fn(),
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
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))

import { generateCodes } from './actions'

// Mirrors CODE_CHARS in ./actions.ts. It cannot be imported: a 'use server'
// module may only export async functions and generateCodeSegment is private.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_PATTERN = new RegExp(`^WWV-[${ALPHABET}]{5}-[${ALPHABET}]{5}$`)

const ADMIN = { id: 'admin_1', app_metadata: { role: 'admin' } }

beforeEach(() => {
  mockGetUser.mockReset()
  mockInsert.mockReset()
  mockRevalidatePath.mockReset()

  mockGetUser.mockResolvedValue({ data: { user: ADMIN } })
  mockInsert.mockResolvedValue({ error: null })
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
