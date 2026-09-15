import { NextResponse } from 'next/server'
import { alertingConfigState } from '@/lib/alerts/notify'

export const dynamic = 'force-dynamic'

/**
 * Liveness plus the one piece of standing configuration an operator cannot
 * otherwise see from outside.
 *
 * Alerting is reported, never enforced: an unconfigured channel means the hub
 * drops its billing alerts, and that is exactly what this endpoint exists to make
 * visible. It is NOT a health failure, so `status` stays "ok" in every case - a
 * deploy check, a load balancer or the billing e2e workflow that probes this route
 * must not be turned red by a hub that is running correctly but not yet wired to
 * a channel. The distinction is carried by `alerting.status` alone.
 *
 * Transport NAMES only. The configured values are secrets and never leave the
 * process through here.
 */
export function GET() {
  const { status, transports, incomplete } = alertingConfigState()
  return NextResponse.json({ status: 'ok', alerting: { status, transports, incomplete } })
}
