import { redirect } from 'next/navigation'

export default function AdminPage() {
  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  redirect('/admin/codes')
}
