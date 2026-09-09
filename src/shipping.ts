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

export async function quote(parcel: Parcel, toAlpha2: string): Promise<Rate[]> {
  const shipment = await shippo()
    .shipments.create(
      {
        addressFrom: {
          country: process.env.SHIP_FROM_COUNTRY ?? 'US',
          zip: process.env.SHIP_FROM_ZIP ?? '',
          city: process.env.SHIP_FROM_CITY ?? '',
          state: process.env.SHIP_FROM_STATE ?? '',
          street1: process.env.SHIP_FROM_STREET ?? '',
        },
        addressTo: { country: toAlpha2.toUpperCase() },
        parcels: [
          {
            weight: String(parcel.weightGrams),
            massUnit: 'g',
            length: String(parcel.lengthCm),
            width: String(parcel.widthCm),
            height: String(parcel.heightCm),
            distanceUnit: 'cm',
          },
        ],
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
