export type Parcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
export type ShipLine = { kitSku: string; quantity: number };

/**
 * One box for the whole order: weight adds up, and the kits are treated as
 * stacked — the footprint is the largest single kit's, the height is the sum.
 *
 * ponytail: no bin packing. A twenty-line order quotes as one absurd tower and
 * over-quotes; split into several parcels when the over-quote costs a sale.
 */
export function parcelFor(lines: ShipLine[], dims: Map<string, Parcel>): Parcel {
  if (!lines.length) throw new Error('parcelFor needs at least one line');

  let weightGrams = 0;
  let lengthCm = 0;
  let widthCm = 0;
  let heightCm = 0;

  for (const { kitSku, quantity } of lines) {
    const kit = dims.get(kitSku);
    // Never let a missing kit become a NaN parcel: the carrier would reject it
    // with something unreadable instead of naming the sku we failed to look up.
    if (!kit) throw new Error(`no parcel dimensions for kit ${kitSku}`);
    weightGrams += kit.weightGrams * quantity;
    lengthCm = Math.max(lengthCm, kit.lengthCm);
    widthCm = Math.max(widthCm, kit.widthCm);
    heightCm += kit.heightCm * quantity;
  }

  return { weightGrams, lengthCm, widthCm, heightCm };
}

/**
 * ponytail: a static zone table, not the carrier's coverage API. Replace it the
 * first time a destination we advertise turns out to be unserviceable at quote
 * time. `'*'` is the catch-all so this stays twenty lines instead of 250 codes.
 */
export const ZONES = [
  {
    zone: 'north-america',
    methods: ['Ground', 'Express'],
    countries: ['USA', 'CAN', 'MEX'] as readonly string[] | '*',
  },
  {
    zone: 'europe',
    methods: ['Standard', 'Express'],
    countries: [
      'ESP', 'PRT', 'FRA', 'DEU', 'ITA', 'NLD', 'BEL', 'IRL', 'GBR',
      'AUT', 'CHE', 'DNK', 'SWE', 'NOR', 'FIN', 'POL', 'CZE', 'GRC',
    ] as readonly string[] | '*',
  },
  { zone: 'rest-of-world', methods: ['International Economy'], countries: '*' as readonly string[] | '*' },
] as const;

/** Sanctions and carrier embargoes are a real list; this is a placeholder for one. */
export const NOT_SERVED: readonly string[] = ['PRK', 'ATA', 'HMD', 'BVT'];

export function zoneFor(alpha3: string): (typeof ZONES)[number] | null {
  const code = alpha3.toUpperCase();
  if (NOT_SERVED.includes(code)) return null;
  return (
    ZONES.find((z) => z.countries !== '*' && z.countries.includes(code)) ??
    ZONES.find((z) => z.countries === '*') ??
    null
  );
}
