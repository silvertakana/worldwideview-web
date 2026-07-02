import { NextResponse } from 'next/server'
import { createClient } from '../../../../../lib/supabase/server'
import { crossServiceFetch } from '../../../../../lib/cross-service/fetch'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const res = await crossServiceFetch('/api/instance', {
    searchParams: { userId: user.id, email: user.email ?? '' },
  })
  const data = await res.json().catch(() => ({ workspaces: [] }))

  // TODO: could eventually switch to checking account instance count
  // instead of listing all instances, once Account model is fully integrated.
  return NextResponse.json({ hasInstances: (data.workspaces?.length ?? data.instances?.length ?? 0) > 0 })
}
