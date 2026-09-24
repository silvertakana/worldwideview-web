import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PricingContent from "./PricingContent";

/**
 * The pricing page, rendered the way the SERVER renders it.
 *
 * Everything else about this fix is proven by inference: a unit test pins
 * formatPrice's output, a grep shows no price literal is left in the render path,
 * and the page composes the two. None of that is the same as looking at the
 * markup. This does - renderToStaticMarkup produces exactly the HTML a visitor is
 * sent, so "US$19" here is the string on the page and not a deduction.
 *
 * renderToStaticMarkup runs no effects, which is why nothing here needs a Supabase
 * stub or an IntersectionObserver: the auth subscription in PricingContent and the
 * observer in AnimateIn both live in useEffect and never fire. The component needs
 * no provider.
 *
 * The assertions are literal strings, deliberately not a snapshot. A snapshot would
 * have captured the broken "$19" on the day it was taken and gone green forever -
 * the check has to name the thing that would have shipped wrong.
 */
function renderPricing(paused = false): string {
  return renderToStaticMarkup(<PricingContent paused={paused} />);
}

/** The page's visible text, with tags and their class names stripped out. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("the pricing page as it is actually rendered", () => {
  it("prices Cloud Pro at US$19 per month, in a named currency", () => {
    const text = visibleText(renderPricing());

    // The currency and the interval have to arrive together: "US$19" alone does
    // not say per month, and "/month" alone does not say which dollar.
    expect(text).toContain("US$19 /month");
  });

  it("prices the local tier at US$0 forever", () => {
    // The second hardcoded literal the same bug produced: the Free card carried a
    // "$0" written by hand, so it was "free" in no particular currency.
    expect(visibleText(renderPricing())).toContain("US$0 forever");
  });

  it("no longer renders the bare dollar strings that shipped", () => {
    const html = renderPricing();

    // These are the exact values the two cards held while the page advertised "$19"
    // and Stripe charged NZ$19.
    expect(html).not.toContain(">$19<");
    expect(html).not.toContain(">$0<");
  });

  it("never renders a price with no currency in front of it", () => {
    // A bare amount can only be correct in the one currency it happens to denote.
    // US$19 contains "S$19", so excluding an S before the symbol is what makes this
    // a test for a MISSING currency rather than a match on the fixed string.
    expect(visibleText(renderPricing())).not.toMatch(/[^S]\$\d/);
  });

  it("renders the prices in every state the page can be in", () => {
    // `paused` swaps the Pro card's call to action for a "Temporarily unavailable"
    // label (the runtime kill switch). The price must survive that branch, because
    // a paused site is exactly when nobody is looking at it.
    for (const paused of [false, true]) {
      const text = visibleText(renderPricing(paused));
      expect(text).toContain("US$19 /month");
      expect(text).toContain("US$0 forever");
    }
  });
});
