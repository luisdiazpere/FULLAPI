import { pool, type Kit } from './db.ts';
import { parcelFor, type Parcel } from './parcel.ts';
import { purchaseLabel, type ShipToAddress } from './shipping.ts';
import { loadSession } from './stripeClient.ts';
import {
  markPaymentEmailSent,
  markShippingEmailSent,
  recordShipment,
} from './orders.ts';
import { sendPaymentConfirmation, sendShippingStatusEmail, sendWelcomeEmail } from './email.ts';
import { enqueue, queueConfigured, type QueueName } from './queue.ts';

/**
 * The work that used to happen inline inside the Stripe webhook.
 *
 * Both of these had already failed in production for reasons a retry would have
 * fixed: the confirmation email timed out against a blocked SMTP port and took the
 * whole webhook down with it for 120s, and the label purchase threw because a
 * carrier had no rate for that country. Neither is something Stripe should be told
 * about, and both deserve a retry — which is the entire argument for a queue here.
 *
 * Handlers take only what fits in JSON, and re-read anything large from Stripe or
 * Postgres, so a job that sits in the queue over a deploy still does the right thing.
 */

export type EmailJob =
  | { kind: 'payment-confirmation'; sessionId: string }
  | { kind: 'welcome'; to: string }
  | { kind: 'shipping-status'; sessionId: string; to: string; trackingNumber: string | null; status: string };

export type ShippingJob = { kind: 'purchase-label'; sessionId: string };

export async function runEmailJob(data: EmailJob): Promise<void> {
  switch (data.kind) {
    case 'welcome':
      return sendWelcomeEmail(data.to);

    case 'shipping-status': {
      await sendShippingStatusEmail(
        data.to,
        { sessionId: data.sessionId, trackingNumber: data.trackingNumber },
        data.status,
      );
      await markShippingEmailSent(data.sessionId, data.status);
      return;
    }

    case 'payment-confirmation': {
      // Re-read rather than trusting the payload: on a retry hours later this is
      // still the order as it stands, and the guard below keeps a duplicate
      // delivery from sending a second receipt.
      const { rows } = await pool.query<{ email: string | null; amount_total: number | null; currency: string | null; payment_email_sent_at: Date | null }>(
        'SELECT email, amount_total, currency, payment_email_sent_at FROM orders WHERE session_id = $1',
        [data.sessionId],
      );
      const order = rows[0];
      if (!order?.email || order.payment_email_sent_at) return;

      const loaded = await loadSession(data.sessionId);
      await sendPaymentConfirmation(order.email, {
        sessionId: data.sessionId,
        amountTotal: order.amount_total,
        currency: order.currency,
        items: loaded.items,
      });
      await markPaymentEmailSent(data.sessionId);
      return;
    }
  }
}

export async function runShippingJob(data: ShippingJob): Promise<void> {
  const loaded = await loadSession(data.sessionId);
  const details = loaded.session.shipping_details;
  const address = details?.address;
  if (!address?.country) throw new Error('no shipping address on the session');

  const lines = loaded.items
    .filter((i): i is typeof i & { kitSku: string } => Boolean(i.kitSku))
    .map((i) => ({ kitSku: i.kitSku, quantity: i.quantity ?? 1 }));
  if (!lines.length) throw new Error('no identifiable kits on the session');

  const skus = [...new Set(lines.map((l) => l.kitSku))];
  const { rows } = await pool.query<Kit>('SELECT * FROM kits WHERE sku = ANY($1)', [skus]);
  const dims = new Map<string, Parcel>(rows.map((k) => [k.sku, {
    weightGrams: k.weight_grams, lengthCm: k.length_cm, widthCm: k.width_cm, heightCm: k.height_cm,
  }]));
  if (lines.some((l) => !dims.has(l.kitSku))) throw new Error('missing parcel dimensions for a purchased kit');

  const addressTo: ShipToAddress = {
    name: details?.name ?? undefined,
    street1: address.line1 ?? undefined,
    city: address.city ?? undefined,
    state: address.state ?? undefined,
    zip: address.postal_code ?? undefined,
    country: address.country,
  };

  const label = await purchaseLabel(parcelFor(lines, dims), addressTo, data.sessionId);
  await recordShipment(data.sessionId, {
    shippoShipmentId: label.shipmentId,
    shippoTransactionId: label.transactionId,
    trackingNumber: label.trackingNumber,
    trackingUrl: label.trackingUrl,
    carrier: label.carrier,
  });
}

export const handlers: Record<QueueName, (jobName: string, data: unknown) => Promise<unknown>> = {
  email: async (_name, data) => runEmailJob(data as EmailJob),
  shipping: async (_name, data) => runShippingJob(data as ShippingJob),
};

/**
 * Queue the work when there is a queue, otherwise do it here and now.
 *
 * The inline path is the old behaviour, kept so the shop runs with no REDIS_URL —
 * but it swallows the failure rather than rethrowing, because the caller is a
 * webhook and neither Stripe nor Shippo can fix a broken SMTP port by retrying.
 */
export async function runOrQueue(
  name: QueueName,
  data: EmailJob | ShippingJob,
  log: { error: (o: unknown, m: string) => void },
): Promise<{ queued: boolean; jobId: string | null }> {
  if (queueConfigured()) {
    const jobId = await enqueue(name, data.kind, data);
    return { queued: true, jobId };
  }
  try {
    await handlers[name](data.kind, data);
  } catch (err) {
    log.error({ err, job: data.kind }, 'inline job failed and there is no queue to retry it');
  }
  return { queued: false, jobId: null };
}
