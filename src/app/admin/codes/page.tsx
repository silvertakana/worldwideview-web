import { requireAdmin } from '@/lib/auth/admin'
import { createClient } from '@/lib/supabase/server'
import { GenerateForm } from './GenerateForm'
import { CodesTable } from './CodesTable'

export interface AccessCode {
  id: string
  code: string
  grants_days: number
  tier: string
  max_uses: number
  use_count: number
  expires_at: string | null
  revoked_at: string | null
  notes: string | null
  created_at: string
  created_by: string | null
}

export default async function AdminCodesPage() {
  await requireAdmin()

  const supabase = await createClient()
  const { data: codes } = await supabase
    .from('access_codes')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <div>
      <GenerateForm />
      <CodesTable codes={(codes ?? []) as AccessCode[]} />
    </div>
  )
}
