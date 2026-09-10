import Stripe from 'stripe';
import { env } from './env.ts';

export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export type SessionItem = {
  name: string | null;
  image: string | null;
  kitSku: string | null;
  countryCode: string | null;
  quantity: number | null;
  amountTotal: number | null;
};

export type LoadedSession = {
  status: Stripe.Checkout.Session.Status | null;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  email: string | null;
  items: SessionItem[];
  session: Stripe.Checkout.Session;
};

/** Backs both the confirmation page's poll and the webhook: one place shapes a session's line items. */
export async function loadSession(sessionId: string): Promise<LoadedSession> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items.data.price.product'],
  });

  const items = (session.line_items?.data ?? []).map((line) => {
    const product = line.price?.product;
    const named =
      product && typeof product === 'object' && !('deleted' in product && product.deleted)
        ? (product as Stripe.Product)
        : null;
    return {
      name: named?.name ?? null,
      image: named?.images?.[0] ?? null,
      kitSku: named?.metadata?.kit_sku ?? null,
      countryCode: named?.metadata?.country_code ?? null,
      quantity: line.quantity ?? null,
      amountTotal: line.amount_total ?? null,
    };
  });

  return {
    status: session.status,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    email: session.customer_details?.email ?? null,
    items,
    session,
  };
}
