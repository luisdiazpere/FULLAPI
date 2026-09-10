/**
 * Shippo's tracking_status.status -> our shipping_status, and whether a status
 * this coarse is actually worth emailing a customer about. Pure and dependency
 * free, so it is unit-tested without a DB (test/shipping-status.test.ts).
 */
const SHIPPO_STATUS_MAP: Record<string, { status: string; emailWorthy: boolean }> = {
  UNKNOWN: { status: 'unfulfilled', emailWorthy: false },
  PRE_TRANSIT: { status: 'label_created', emailWorthy: false },
  TRANSIT: { status: 'in_transit', emailWorthy: true },
  DELIVERED: { status: 'delivered', emailWorthy: true },
  FAILURE: { status: 'failed', emailWorthy: true },
  RETURNED: { status: 'returned', emailWorthy: true },
};

export function mapShippoStatus(raw: string): { status: string; emailWorthy: boolean } | null {
  return SHIPPO_STATUS_MAP[raw] ?? null;
}
