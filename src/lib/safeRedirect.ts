/**
 * Validates a redirect URL to prevent open redirect vulnerabilities.
 *
 * Only allows relative paths starting with `/` and rejects external URLs,
 * protocol-relative URLs, and encoded attack vectors.
 *
 * @param next - The redirect target from query params (nullable).
 * @param fallback - Default redirect if `next` is null or unsafe.
 * @returns A safe relative URL string.
 */
export function getSafeRedirect(next: string | null, fallback = '/accounts'): string {
  if (!next) return fallback

  // Only allow relative paths starting with `/`
  // Reject protocol-relative URLs (//evil.com) and backslash-based escapes
  if (/^\/(?!\/|\\)/.test(next)) {
    return next
  }

  return fallback
}
