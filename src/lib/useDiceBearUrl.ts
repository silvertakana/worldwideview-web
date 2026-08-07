'use client'

import { useEffect, useState } from 'react'
import { diceBearUrl } from './diceBear'

/**
 * Resolves a DiceBear avatar URL for the given seed.
 *
 * Returns null until the async hash + URL build completes, so callers can
 * render a placeholder instead of a broken image.
 *
 * This hook must live in its own `"use client"` module: the underlying
 * diceBear module (src/lib/diceBear.ts) is also imported by the server-side
 * /api/avatar route, so the hook cannot be co-located there without pulling
 * React hooks across the RSC boundary.
 *
 * @param seed - Stable identity string, or null to clear the avatar URL.
 */
export function useDiceBearUrl(seed: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!seed) {
      setUrl(null)
      return
    }
    let cancelled = false
    diceBearUrl(seed).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [seed])

  return url
}
