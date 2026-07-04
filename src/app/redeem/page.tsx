import { redirect } from 'next/navigation'

export default function OldRedeemPage() {
  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  redirect('/accounts/redeem')
}
