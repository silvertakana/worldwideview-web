import { describe, it, expect } from 'vitest'
import { PRICING_DISPLAY, formatPrice } from './constants'

/**
 * The advertised price is the one number on the site a visitor acts on, so it is
 * pinned here rather than only asserted through a component. The bug these tests
 * exist for: the page rendered a bare "$19" while Stripe, on a NZ account,
 * charged NZ$19 - every layer was internally consistent and the price a customer
 * read was still wrong.
 */
describe('PRICING_DISPLAY', () => {
  it('advertises Pro monthly at 1900 USD, matching the Stripe price actually charged', () => {
    // 1900 is Stripe's unit_amount for price_1UJKhbCx18aFAZYvn3sMhmmI (USD, monthly).
    expect(PRICING_DISPLAY.proMonthly).toEqual({ amount: 1900, currency: 'USD', interval: 'month' })
  })

  it('advertises Pro annual at 19000 USD', () => {
    // price_1UJKhbCx18aFAZYvV4IvPuA7.
    expect(PRICING_DISPLAY.proAnnual).toEqual({ amount: 19000, currency: 'USD', interval: 'year' })
  })

  it('advertises the local tier as free', () => {
    expect(PRICING_DISPLAY.local.amount).toBe(0)
    expect(PRICING_DISPLAY.local.interval).toBeUndefined()
  })

  it('states a currency for every price, so no amount is ever bare', () => {
    for (const price of Object.values(PRICING_DISPLAY)) {
      expect(price.currency).toMatch(/^[A-Z]{3}$/)
    }
  })
})

describe('formatPrice', () => {
  it('renders USD with an explicit US$ rather than a bare $', () => {
    expect(formatPrice(1900, 'USD')).toBe('US$19')
    expect(formatPrice(19000, 'USD')).toBe('US$190')
    expect(formatPrice(0, 'USD')).toBe('US$0')
  })

  it('accepts the lowercased currency code Stripe actually returns', () => {
    // Stripe says "usd". A missed lookup would silently print "usd 19", so the
    // formatter normalises instead of trusting its caller to remember.
    expect(formatPrice(1900, 'usd')).toBe('US$19')
  })

  it('names the currency in the fallback instead of guessing a symbol', () => {
    // The old behaviour was a bare "$" for everything, which is only ever correct
    // for one currency. A code we cannot symbolise is uglier but never wrong.
    expect(formatPrice(1900, 'NZD')).toBe('NZD 19')
    expect(formatPrice(1900, 'nzd')).toBe('NZD 19')
  })

  it('keeps cents when the amount is not a whole unit', () => {
    expect(formatPrice(1999, 'USD')).toBe('US$19.99')
    expect(formatPrice(1950, 'USD')).toBe('US$19.50')
  })
})
