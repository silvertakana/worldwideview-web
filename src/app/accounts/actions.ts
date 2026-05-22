'use server'

import { redirect } from 'next/navigation'
import { createClient } from '../../lib/supabase/server'

export async function signOut() {
  const supabase = await createClient()
  // Clears the session cookie on the parent domain (ADR-003D) so every
  // subdomain is de-authenticated, not just this one.
  await supabase.auth.signOut()
  redirect('/login')
}
