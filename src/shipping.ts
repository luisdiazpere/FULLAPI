import { Shippo } from 'shippo';
import type { Parcel } from './parcel.ts';

export class ShippingUpstreamError extends Error {}
export class ShippingUnconfiguredError extends Error {}

export type Rate = {
  carrier: string;
  service: string;
  amount: number; // minor units, like every other price in this app
  currency: string;
  estimatedDays: number | null;
};

const TIMEOUT_MS = 15_000; // carriers are slower than REST Countries; see src/countries.ts:62

/**
 * The whole vendor contract lives in this file. Swapping to EasyPost means
 * rewriting it behind the same two exports, and changing nothing else.
 */
let client: Shippo | null = null;

function shippo(): Shippo {
  const key = process.env.SHIPPO_API_KEY;
  if (!key) throw new ShippingUnconfiguredError('SHIPPO_API_KEY is not set');
  client ??= new Shippo({ apiKeyHeader: key });
  return client;
}

export const shippingConfigured = (): boolean => Boolean(process.env.SHIPPO_API_KEY);

/**
 * Shippo quotes an amount as a decimal string of major units ("12.50"); every
 * price in this app is an integer of minor units. Convert once, here, so no
 * other module has to know the carrier's format.
 */
export function minorUnits(amount: string): number | null {
  // Number('') is 0, which would quote free shipping off a blank field.
  if (!amount?.trim()) return null;
  const major = Number(amount);
  if (!Number.isFinite(major) || major < 0) return null;
  return Math.round(major * 100);
}

const addressFrom = () => ({
  country: process.env.SHIP_FROM_COUNTRY ?? 'US',
  zip: process.env.SHIP_FROM_ZIP ?? '',
  city: process.env.SHIP_FROM_CITY ?? '',
  state: process.env.SHIP_FROM_STATE ?? '',
  street1: process.env.SHIP_FROM_STREET ?? '',
});

const parcelPayload = (parcel: Parcel) => ({
  weight: String(parcel.weightGrams),
  massUnit: 'g' as const,
  length: String(parcel.lengthCm),
  width: String(parcel.widthCm),
  height: String(parcel.heightCm),
  distanceUnit: 'cm' as const,
});

export async function quote(parcel: Parcel, toAlpha2: string): Promise<Rate[]> {
  const shipment = await shippo()
    .shipments.create(
      {
        addressFrom: addressFrom(),
        addressTo: { country: toAlpha2.toUpperCase() },
        parcels: [parcelPayload(parcel)],
        async: false,
      },
      { timeoutMs: TIMEOUT_MS },
    )
    .catch((cause: unknown) => {
      throw new ShippingUpstreamError(cause instanceof Error ? cause.message : 'carrier request failed');
    });

  // A carrier with no service to a destination returns zero rates rather than an
  // error, and that is an answer, not a failure. The caller reports it as such.
  return (shipment.rates ?? []).flatMap((rate) => {
    const amount = minorUnits(rate.amount);
    if (amount === null) return [];
    return [{
      carrier: rate.provider,
      service: rate.servicelevel?.name ?? rate.servicelevel?.token ?? 'standard',
      amount,
      currency: rate.currency.toLowerCase(),
      estimatedDays: rate.estimatedDays ?? null,
    }];
  });
}

export type ShipToAddress = {
  name?: string;
  street1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country: string;
};

export type PurchasedLabel = {
  shipmentId: string;
  transactionId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
};

/**
 * Buys the cheapest available label for a real destination address and
 * returns its tracking info. `metadata` is the Stripe session id: Shippo
 * echoes it back on every tracking webhook event, which is how a later
 * track_updated event finds its way back to the right order without a
 * separate correlation table.
 */
export async function purchaseLabel(
  parcel: Parcel,
  addressTo: ShipToAddress,
  metadata: string,
): Promise<PurchasedLabel> {
  const shipment = await shippo()
    .shipments.create(
      { addressFrom: addressFrom(), addressTo, parcels: [parcelPayload(parcel)], metadata, async: false },
      { timeoutMs: TIMEOUT_MS },
    )
    .catch((cause: unknown) => {
      throw new ShippingUpstreamError(cause instanceof Error ? cause.message : 'carrier request failed');
    });

  const cheapest = shipment.rates.reduce<(typeof shipment.rates)[number] | null>(
    (best, rate) => (!best || Number(rate.amount) < Number(best.amount) ? rate : best),
    null,
  );
  if (!cheapest) throw new ShippingUpstreamError(`no rates available to ${addressTo.country}`);

  const transaction = await shippo()
    .transactions.create(
      { rate: cheapest.objectId, labelFileType: 'PDF', metadata, async: false },
      { timeoutMs: TIMEOUT_MS },
    )
    .catch((cause: unknown) => {
      throw new ShippingUpstreamError(cause instanceof Error ? cause.message : 'label purchase failed');
    });

  return {
    shipmentId: shipment.objectId,
    transactionId: transaction.objectId ?? '',
    trackingNumber: transaction.trackingNumber ?? null,
    trackingUrl: transaction.trackingUrlProvider ?? null,
    carrier: cheapest.provider ?? null,
  };
}
