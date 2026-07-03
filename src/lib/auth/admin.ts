import { redirect } from 'next/navigation'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  if (!user) redirect('/login?next=/admin')
  if (user.app_metadata?.role !== 'admin') notFound()

  return user
}
