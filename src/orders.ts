import { pool } from './db.ts';

export type OrderRow = {
  session_id: string;
  email: string | null;
  amount_total: number | null;
  currency: string | null;
  payment_status: string;
  shipping_status: string;
  shipping_address: unknown;
  shippo_shipment_id: string | null;
  shippo_transaction_id: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  payment_email_sent_at: Date | null;
  last_shipping_email_status: string | null;
  created_at: Date;
  updated_at: Date;
};

/** True if this event id was already processed — the webhook should no-op. */
export async function alreadyProcessed(eventId: string, source: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'INSERT INTO processed_webhook_events (id, source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [eventId, source],
  );
  return rowCount === 0;
}

export async function getOrder(sessionId: string): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>('SELECT * FROM orders WHERE session_id = $1', [sessionId]);
  return rows[0] ?? null;
}

export async function recordPayment(order: {
  sessionId: string;
  email: string | null;
  amountTotal: number | null;
  currency: string | null;
  shippingAddress: unknown;
}): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>(
    `INSERT INTO orders (session_id, email, amount_total, currency, payment_status, shipping_address)
     VALUES ($1, $2, $3, $4, 'paid', $5)
     ON CONFLICT (session_id) DO UPDATE SET
       email = EXCLUDED.email,
       amount_total = EXCLUDED.amount_total,
       currency = EXCLUDED.currency,
       payment_status = 'paid',
       shipping_address = EXCLUDED.shipping_address,
       updated_at = now()
     RETURNING *`,
    [order.sessionId, order.email, order.amountTotal, order.currency, JSON.stringify(order.shippingAddress)],
  );
  return rows[0]!;
}

export async function markPaymentEmailSent(sessionId: string): Promise<void> {
  await pool.query('UPDATE orders SET payment_email_sent_at = now() WHERE session_id = $1', [sessionId]);
}

export async function recordShipment(sessionId: string, shipment: {
  shippoShipmentId: string;
  shippoTransactionId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE orders SET
       shipping_status = 'label_created',
       shippo_shipment_id = $2,
       shippo_transaction_id = $3,
       tracking_number = $4,
       tracking_url = $5,
       carrier = $6,
       updated_at = now()
     WHERE session_id = $1`,
    [sessionId, shipment.shippoShipmentId, shipment.shippoTransactionId, shipment.trackingNumber,
      shipment.trackingUrl, shipment.carrier],
  );
}

export async function markShippingEmailSent(sessionId: string, status: string): Promise<void> {
  await pool.query('UPDATE orders SET last_shipping_email_status = $2 WHERE session_id = $1', [sessionId, status]);
}

/**
 * Applies a mapped tracking status to the order and says whether it is new
 * enough to email about (a status already emailed does not email again).
 */
export async function applyTrackingUpdate(
  sessionId: string,
  mapped: { status: string; emailWorthy: boolean },
): Promise<{ order: OrderRow; shouldEmail: boolean } | null> {
  const order = await getOrder(sessionId);
  if (!order) return null;

  await pool.query('UPDATE orders SET shipping_status = $2, updated_at = now() WHERE session_id = $1',
    [sessionId, mapped.status]);

  const shouldEmail = mapped.emailWorthy && order.last_shipping_email_status !== mapped.status;
  return { order: { ...order, shipping_status: mapped.status }, shouldEmail };
}
