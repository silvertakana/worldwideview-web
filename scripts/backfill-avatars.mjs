#!/usr/bin/env node
/**
 * One-time avatar backfill for the hub: stamp DiceBear avatars onto every
 * existing user that has no avatar_url, and stamp avatar_source provenance
 * on everyone else.
 *
 * This mirrors the store-once + provenance contract in src/lib/avatarStore.ts:
 *   - 'google' | 'github'  OAuth provider avatar (classified from URL host)
 *   - 'upload'             self-uploaded image (Supabase Storage or data: URL)
 *   - 'dicebear'           deterministic offline-generated face (email seed)
 *
 * The DiceBear render is replicated from src/lib/avatarSvg.ts (generateAvatarSvg
 * + VISUAL_OPTIONS) because this is a plain-Node .mjs script and the src libs
 * are TypeScript with extensionless imports. Keep the VISUAL_OPTIONS block
 * byte-identical to src/lib/avatarSvg.ts so backfilled faces match what
 * signup-time generation produces.
 *
 * Usage:
 *   node scripts/backfill-avatars.mjs --dry-run   # compute + report only, no writes
 *   node scripts/backfill-avatars.mjs             # real run (writes user_metadata)
 *
 * Reads env from .env.local (SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL plus
 * SUPABASE_SERVICE_ROLE_KEY). Never prints secrets; emails are masked.
 * Idempotent: re-running skips users that already have avatar_url +
 * avatar_source.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createAvatar } from '@dicebear/core'
import {
  create as adventurerNeutralCreate,
  meta as adventurerNeutralMeta,
  schema as adventurerNeutralSchema,
} from '@dicebear/adventurer-neutral'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const DRY_RUN = process.argv.includes('--dry-run')

const WRITE_DELAY_MS = 100 // rate-limit friendly between metadata writes
const PAGE_DELAY_MS = 60 // between admin user page fetches
const FETCH_TIMEOUT_MS = 15000

const adventurerNeutral = {
  create: adventurerNeutralCreate,
  meta: adventurerNeutralMeta,
  schema: adventurerNeutralSchema,
}

/**
 * Visual options replicated from src/lib/avatarSvg.ts (source of truth). Keep
 * byte-identical so backfilled SVGs match signup-time generation.
 */
const VISUAL_OPTIONS = {
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

// ---------------------------------------------------------------------------
// Env + helpers
// ---------------------------------------------------------------------------

/** Minimal .env.local parser: key=value lines, '#' comments, blank lines. */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {}
  const env = {}
  for (const raw of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }
  return env
}

function maskEmail(email) {
  if (!email) return '(no email)'
  const at = email.indexOf('@')
  if (at <= 0) return email.slice(0, 3) + '***'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return local.slice(0, 3) + '***' + domain
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Avatar logic (mirrors src/lib/avatar.ts + src/lib/avatarSvg.ts)
// ---------------------------------------------------------------------------

function normalizeEmailSeed(email) {
  return (email ?? '').trim().toLowerCase()
}

async function generateAvatarSvg(seed) {
  const hashedSeed = createHash('sha256').update(seed).digest('hex')
  const avatar = createAvatar(adventurerNeutral, {
    ...VISUAL_OPTIONS,
    seed: hashedSeed,
  })
  return avatar.toString()
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

async function buildDicebearAvatarDataUrl(email) {
  const svg = await generateAvatarSvg(normalizeEmailSeed(email))
  return svgToDataUrl(svg)
}

/** True when metadata.avatar_url is a usable http/https/data: string. */
function hasValidAvatarUrl(metadata) {
  const candidate = metadata?.avatar_url
  if (typeof candidate !== 'string' || candidate.trim() === '') return false
  return (
    candidate.startsWith('http://') ||
    candidate.startsWith('https://') ||
    candidate.startsWith('data:')
  )
}

/**
 * Classifies an existing avatar_url into a provenance label from its shape.
 * Mirrors src/lib/avatarStore.ts:avatarSourceForProvider semantics, but the
 * provider is not in the admin list response, so the URL host is the source.
 */
function classifyAvatarSource(avatarUrl) {
  if (avatarUrl.startsWith('data:')) return 'upload'
  let host = ''
  try {
    host = new URL(avatarUrl).hostname
  } catch {
    return null
  }
  if (host === 'lh3.googleusercontent.com') return 'google'
  if (host === 'avatars.githubusercontent.com') return 'github'
  if (host.endsWith('.supabase.co') && avatarUrl.includes('/storage/')) {
    return 'upload'
  }
  return null
}

// ---------------------------------------------------------------------------
// Supabase admin API
// ---------------------------------------------------------------------------

function adminHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

async function fetchAllUsers(baseUrl, key) {
  const users = []
  const perPage = 200
  let page = 1
  for (;;) {
    const url = `${baseUrl}/auth/v1/admin/users?per_page=${perPage}&page=${page}`
    const res = await fetchWithTimeout(url, { headers: adminHeaders(key) })
    if (res.status !== 200) {
      throw new Error(`admin users page ${page} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = await res.json()
    const pageUsers = Array.isArray(body.users) ? body.users : []
    for (const u of pageUsers) {
      users.push({
        id: u.id,
        email: u.email ?? null,
        user_metadata: u.user_metadata ?? {},
      })
    }
    if (pageUsers.length < perPage) break
    page += 1
    await delay(PAGE_DELAY_MS)
  }
  return users
}

/**
 * PUT user_metadata (GoTrue admin updateUserById is PUT; admin update
 * REPLACES metadata, so spread existing first).
 */
async function putUserMetadata(baseUrl, key, userId, userMetadata) {
  const url = `${baseUrl}/auth/v1/admin/users/${userId}`
  const res = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: adminHeaders(key),
    body: JSON.stringify({ user_metadata: userMetadata }),
  })
  if (res.status !== 200) {
    throw new Error(`PUT user ${userId} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Planning + execution
// ---------------------------------------------------------------------------

/**
 * Decides what to do for a user.
 * - skip:      already has avatar_url AND avatar_source (idempotent no-op)
 * - stamp:     has avatar_url, no avatar_source, source classifiable from URL
 * - stamp-skip: has avatar_url, no avatar_source, unclassifiable URL host
 * - generate:  no avatar_url -> build + store dicebear avatar
 */
async function planUser(user) {
  const meta = user.user_metadata
  if (hasValidAvatarUrl(meta)) {
    if (typeof meta.avatar_source === 'string' && meta.avatar_source !== '') {
      return { action: 'skip', reason: `already has avatar (${meta.avatar_source})` }
    }
    const source = classifyAvatarSource(meta.avatar_url)
    if (!source) {
      return { action: 'stamp-skip', reason: 'unclassifiable avatar URL' }
    }
    return {
      action: 'stamp',
      source,
      metadata: { ...meta, avatar_source: source },
    }
  }
  const dataUrl = await buildDicebearAvatarDataUrl(user.email)
  return {
    action: 'generate',
    metadata: { ...meta, avatar_url: dataUrl, avatar_source: 'dicebear' },
  }
}

function printSummary(stats) {
  console.log('')
  console.log('=== SUMMARY ===')
  console.log(`Total users:            ${stats.total}`)
  console.log(`Already have avatar:    ${stats.haveAvatar}`)
  console.log(`  source=google:        ${stats.haveGoogle}`)
  console.log(`  source=github:        ${stats.haveGithub}`)
  console.log(`  source=upload:        ${stats.haveUpload}`)
  console.log(`  source=unknown-host:  ${stats.haveUnknown}`)
  console.log(`To stamp source:        ${stats.toStamp}`)
  console.log(`To generate:            ${stats.toGenerate}`)
  console.log(`Skip (already done):    ${stats.skip}`)
  console.log(`Stamp-skip (no match):  ${stats.stampSkip}`)
  console.log(`Errors:                 ${stats.errors}`)
}

async function main() {
  const localEnv = {
    ...loadEnvFile(join(REPO_ROOT, '.env.local')),
    ...loadEnvFile(join(REPO_ROOT, '.env')),
  }
  const baseUrl = localEnv.SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL
  const key = localEnv.SUPABASE_SERVICE_ROLE_KEY
  if (!baseUrl) {
    console.error('[fatal] SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL missing from .env.local')
    process.exit(1)
  }
  if (!key) {
    console.error('[fatal] SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
    process.exit(1)
  }

  console.log(`Avatar backfill — ${DRY_RUN ? 'DRY RUN (no writes)' : 'REAL RUN (writes metadata)'}`)
  console.log(`Supabase: ${baseUrl.replace(/^https?:\/\//, '')}`)
  console.log('Fetching users...')

  const users = await fetchAllUsers(baseUrl, key)
  console.log(`Fetched ${users.length} users.`)

  const stats = {
    total: users.length,
    haveAvatar: 0,
    haveGoogle: 0,
    haveGithub: 0,
    haveUpload: 0,
    haveUnknown: 0,
    toStamp: 0,
    toGenerate: 0,
    skip: 0,
    stampSkip: 0,
    errors: 0,
  }

  const actions = []
  for (const user of users) {
    let plan
    try {
      plan = await planUser(user)
    } catch (err) {
      stats.errors += 1
      console.log(`[error] ${maskEmail(user.email)} — ${err.message}`)
      continue
    }
    actions.push({ user, plan })

    if (plan.action === 'skip') {
      stats.skip += 1
      stats.haveAvatar += 1
      const src = typeof user.user_metadata.avatar_source === 'string'
        ? user.user_metadata.avatar_source
        : null
      if (src === 'google') stats.haveGoogle += 1
      else if (src === 'github') stats.haveGithub += 1
      else if (src === 'upload') stats.haveUpload += 1
      console.log(`[skip]    ${maskEmail(user.email)} — ${plan.reason}`)
      continue
    }
    if (plan.action === 'stamp-skip') {
      stats.stampSkip += 1
      stats.haveAvatar += 1
      stats.haveUnknown += 1
      console.log(`[stamp-skip] ${maskEmail(user.email)} — ${plan.reason}`)
      continue
    }
    if (plan.action === 'stamp') {
      stats.toStamp += 1
      stats.haveAvatar += 1
      if (plan.source === 'google') stats.haveGoogle += 1
      else if (plan.source === 'github') stats.haveGithub += 1
      else if (plan.source === 'upload') stats.haveUpload += 1
      console.log(`[stamp]   ${maskEmail(user.email)} — avatar_source: ${plan.source}`)
      continue
    }
    stats.toGenerate += 1
    console.log(`[generate] ${maskEmail(user.email)} — store dicebear avatar`)
  }

  printSummary(stats)

  if (DRY_RUN) {
    console.log('')
    console.log('DRY RUN complete — no writes performed.')
    return
  }

  console.log('')
  console.log('Writing...')
  const actionable = actions.filter(
    (a) => a.plan.action === 'stamp' || a.plan.action === 'generate',
  ).length
  let ok = { stamp: 0, generate: 0 }
  let failed = { stamp: 0, generate: 0 }
  let writes = 0
  for (const { user, plan } of actions) {
    if (plan.action !== 'stamp' && plan.action !== 'generate') continue
    writes += 1
    try {
      await putUserMetadata(baseUrl, key, user.id, plan.metadata)
      ok[plan.action] += 1
      console.log(`[ok]      ${maskEmail(user.email)} — ${plan.action}`)
    } catch (err) {
      failed[plan.action] += 1
      stats.errors += 1
      console.log(`[failed]  ${maskEmail(user.email)} — ${plan.action}: ${err.message}`)
    }
    if (writes < actionable) {
      await delay(WRITE_DELAY_MS)
    }
  }

  console.log('')
  console.log('=== WRITE TALLY ===')
  console.log(`stamp:    ok ${ok.stamp} / failed ${failed.stamp}`)
  console.log(`generate: ok ${ok.generate} / failed ${failed.generate}`)
  console.log(`errors:   ${stats.errors}`)
  console.log('')
  console.log('REAL RUN complete.')
}

main().catch((err) => {
  console.error('[fatal]', err.message)
  process.exit(1)
})
