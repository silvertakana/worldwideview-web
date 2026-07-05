import RedeemForm from './RedeemForm'
import acctStyles from '../accounts.module.css'

export default async function RedeemPage() {
  return (
    <div className={acctStyles.pageContent}>
      <RedeemForm />
    </div>
  )
}
