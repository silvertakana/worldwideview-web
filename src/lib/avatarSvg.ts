import { createHash } from 'node:crypto'
import { createAvatar } from '@dicebear/core'
import {
  create as adventurerNeutralCreate,
  meta as adventurerNeutralMeta,
  schema as adventurerNeutralSchema,
} from '@dicebear/adventurer-neutral'
import type { Options as AdventurerNeutralOptions } from '@dicebear/adventurer-neutral'

/**
 * Offline DiceBear SVG avatar renderer.
 *
 * The hub server container cannot reliably reach api.dicebear.com (TLS to that
 * CDN edge times out from Docker), so generated avatars are rendered
 * in-process from the official @dicebear packages instead of proxying a
 * fetch(). No network call happens anywhere in this module.
 *
 * The style package exports its collection as the three pieces of the core
 * `Style` interface (create/meta/schema); assembled here so createAvatar can
 * consume it.
 */
const adventurerNeutral = {
  create: adventurerNeutralCreate,
  meta: adventurerNeutralMeta,
  schema: adventurerNeutralSchema,
}

/**
 * Visual options replicated from the legacy DICEBEAR_BASE URL so avatars stay
 * byte-identical to what the upstream API served for the same seed.
 */
const VISUAL_OPTIONS: AdventurerNeutralOptions = {
  backgroundColor: ['ffd5dc', 'c0aede', 'b6e3f4', 'f2d3b1'],
  eyebrows: [
    'variant01',
    'variant02',
    'variant03',
    'variant05',
    'variant06',
    'variant07',
    'variant08',
    'variant09',
    'variant10',
    'variant11',
    'variant12',
    'variant13',
    'variant14',
    'variant15',
  ],
  mouth: [
    'variant01',
    'variant02',
    'variant03',
    'variant04',
    'variant09',
    'variant10',
    'variant11',
    'variant12',
    'variant13',
    'variant14',
    'variant15',
    'variant16',
    'variant17',
    'variant18',
    'variant19',
    'variant21',
    'variant22',
    'variant23',
    'variant24',
    'variant25',
    'variant26',
    'variant27',
    'variant28',
    'variant29',
    'variant30',
    'variant20',
  ],
}

/**
 * Renders a deterministic DiceBear adventurer-neutral avatar SVG for a seed.
 *
 * The seed is SHA-256 hashed (node:crypto) before being fed to the PRNG, so
 * raw PII (email, display name) never appears in the SVG output or in any
 * outgoing artifact. Same seed always produces the same SVG; different seeds
 * produce different faces.
 *
 * @param seed - A stable string (email, display name) used to derive a
 *   consistent avatar appearance for the same identity.
 * @returns A promise resolving to the complete SVG document string.
 */
export async function generateAvatarSvg(seed: string): Promise<string> {
  const hashedSeed = createHash('sha256').update(seed).digest('hex')
  const avatar = createAvatar(adventurerNeutral, {
    ...VISUAL_OPTIONS,
    seed: hashedSeed,
  })
  return avatar.toString()
}
