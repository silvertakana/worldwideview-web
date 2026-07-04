// nosemgrep
import { redirect } from 'next/navigation'

export default function HubPage() {
  redirect('/accounts/instances')
}
