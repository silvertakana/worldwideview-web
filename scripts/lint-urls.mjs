#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative } from 'path'

const args = process.argv.slice(2)
const domainIdx = args.indexOf('--domain')
const DOMAINS = domainIdx >= 0 && args[domainIdx + 1] ? [args[domainIdx + 1]] : ['worldwideview.dev']
const SRC_ROOTS = ['src', 'app', 'pages'].filter((d) => existsSync(join(process.cwd(), d)))
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
const EXCLUDE = [/node_modules/, /\.next/, /dist/, /build/, /coverage/]
const FILE_ALLOW = [/\.env/, /next\.config/, /lint-urls/, /README/, /\.md$/]
const LINE_ALLOW = [/process\.env/, /\|\|/, /\?\?/, /\/\/\s*lint-url:\s*allow/i, /\{\/\*\s*lint-url:\s*allow\s*\*\/\}/i, /^\s*\/\//, /^\s*\*/]

let violations = 0
const found = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (EXCLUDE.some((re) => re.test(full))) continue
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    if (!EXTS.some((ext) => full.endsWith(ext))) continue
    if (FILE_ALLOW.some((re) => re.test(full))) continue
    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!DOMAINS.some((d) => line.includes(d))) return
      if (LINE_ALLOW.some((re) => re.test(line))) return
      found.push(`  ${relative(process.cwd(), full)}:${i + 1}: ${line.trim()}`)
      violations++
    })
  }
}

for (const root of SRC_ROOTS) walk(join(process.cwd(), root))

if (violations > 0) {
  console.error(`\n[FAIL] URL Linter: ${violations} hardcoded production URL(s) found.\n`)
  console.error('Lines reference production domains without an env-var override.')
  console.error('Fix: move the URL to an env var with this value as the default,')
  console.error('     or suppress with "// lint-url: allow" if intentional.\n')
  found.forEach((l) => console.error(l))
  console.error('')
  process.exit(1)
} else {
  console.log('[PASS] URL Linter: no hardcoded production URLs.')
  process.exit(0)
}
