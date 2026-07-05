import { redirect } from 'next/navigation'

export default function OldRedeemRedirect() {
  // nosemgrep: semgrep.unsanitized-redirect - hardcoded path, not user-controlled
  redirect('/accounts/redeem')
}
