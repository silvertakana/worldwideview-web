import Stripe from "stripe";

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY environment variable is required");
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-05-27.dahlia",
      // Test-stack routing: docker-compose.test.yml sets STRIPE_HOST / STRIPE_PORT /
      // STRIPE_PROTOCOL to point outbound calls at stripe-mock instead of api.stripe.com.
      // Production never sets these env vars, so the client keeps Stripe's defaults.
      // NOTE: stripe-mock is stateless, so outbound retrieve() calls return fixture
      // data that will not match incoming webhook payload IDs; handler lookups are
      // best-effort in test mode.
      ...(process.env.STRIPE_HOST ? { host: process.env.STRIPE_HOST } : {}),
      ...(process.env.STRIPE_PORT ? { port: process.env.STRIPE_PORT } : {}),
      ...(process.env.STRIPE_PROTOCOL === "http" || process.env.STRIPE_PROTOCOL === "https"
        ? { protocol: process.env.STRIPE_PROTOCOL }
        : {}),
    });
  }
  return stripeInstance;
}
