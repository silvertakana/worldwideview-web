# Fixing a locked-out customer by hand

Use this when a paying customer cannot get into their globe workspace and billing
has not fixed itself. Screen: **Admin Dashboard -> Billing overrides**
(`/admin/overrides`). You must be signed in as an admin.

## Why this screen exists

Granting a tier in the hub does **not** by itself change what a customer can open.
Real access lives on the globe, in `org_tiers` and the workspace lock. This screen
writes both: the hub records the decision, then the globe is told. If only the
first half lands, the customer is still locked out - and the screen says so.

## The five-minute fix

1. Open `/admin/overrides`.
2. Type the customer's **email** (or their hub user id) and press **Find customer**.
3. Read the **Globe** panel before you touch anything.
   - It shows the tier the customer actually feels right now.
   - If it says *"The globe has no organization for this email"*, stop: a tier push
     cannot land for this customer until a globe workspace exists for them.
4. Pick the **Tier** they should have. Only Free, Pro, Team and Enterprise are
   offered, because those are the only ones the globe accepts. Beta Tester and
   Early Access are hub-only and the globe rejects them outright.
5. Write the **Reason**. This is mandatory and the button stays disabled until you
   write something. Put the *evidence*, not a summary:
   - `Paid 12 Sep, invoice in Stripe, webhook failed, workspace locked. Ticket #4821.`
   - not `customer complained`.
   Six months from now this sentence is the only explanation anyone will have for
   why this account has Pro.
6. Press **Grant override**.
7. Read the banner.

## What the banner means

| Banner | Meaning | What to do |
|---|---|---|
| Green, "The globe now grants ..." | Done. The customer has access. | Tell them to reload. |
| Red, "PARTIAL - the override is recorded in the hub, but the customer still does NOT have access" | The hub recorded your grant; the globe did not receive it. **The customer is still locked out.** | Press **Retry the globe push**. If it keeps failing, read the message and see below. |

The partial case is the one that matters. Never tell a customer they are fixed
until the banner is green.

If you open this screen later and the **Globe** panel shows a different tier from
the **Operator override** panel, that grant never reached the customer. The
**Retry the globe push** button appears for exactly that mismatch, so you do not
need to grant again.

## When the push keeps failing

- **"The globe has no organization for ..."** - this customer has no globe
  workspace. Their access problem is a provisioning problem, not a billing one.
  Escalate it; an override cannot help.
- **"The globe refused our cross-service signature (401)"** - `CROSS_SERVICE_SECRET`
  does not match between the hub and the globe. This is a deployment problem and
  it affects every customer, not this one. Escalate it.
- **"Could not reach the globe"** - the globe is down or unreachable. Wait and
  press **Retry the globe push**.
- Every failed push is also filed in `billing_failures` (`stage = tier_sync`), so
  it is not lost if you close the page.

## Revoking

Press **Revoke override** to end a grant. The globe tier is then recalculated from
whatever the customer has left (a real Stripe subscription, or an access code).

- If what is left is Beta Tester or Early Access, the globe mirror is deliberately
  left where it was, because the globe cannot represent those tiers. The banner
  says so. This errs on the side of the customer keeping access.
- Revoking does not delete anything. The revoked override stays in the audit trail
  at the bottom of the screen, with who granted it, when, why, and who revoked it.

## Things this screen does not do

- It does not write the customer's durable Stripe record. An override sits on top
  of the billing record; it never overwrites one. If a customer later pays, Stripe
  keeps updating their record normally.
- It does not grant Beta Tester or Early Access. Use an access code for those: issue one on
  **Admin Dashboard -> Access codes** and send the customer the redeem link
  (`/accounts/redeem`). Redeeming works exactly as it always did - only the customer-facing
  menu item is gone - so this is now something you hand out, not something a customer finds.
- It never expires on its own. A grant stays until somebody revokes it.

## "It says I need a plan, but I never had a code"

Customers no longer redeem codes to get in, and the code screens are no longer in the menu:
paying is the way in. When a customer is refused with *"No active plan. Choose a plan at
/pricing to create your workspace"*, check Stripe first - that message means no store had a
grant for them (not a Stripe subscription, not an override, not a redeemed code). If they
really did pay, this is the partial case above: grant the override and watch the banner.
The full reasoning is in
[adr-0009](../architecture/decisions/adr-0009-payment-only-access.md).
