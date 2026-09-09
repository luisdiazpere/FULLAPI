export type CartLine = { kitSku: string; countryCode: string; quantity: number };

/**
 * Stock lives on the kit, and one cart can hold the same kit for several
 * countries, so quantities are summed per sku before any of it is held.
 * Sorted by sku so two concurrent carts touch rows in the same order and
 * cannot deadlock each other.
 */
export function holdPlan(items: CartLine[]): [string, number][] {
  const perSku = new Map<string, number>();
  for (const { kitSku, quantity } of items) {
    perSku.set(kitSku, (perSku.get(kitSku) ?? 0) + (quantity ?? 1));
  }
  return [...perSku].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
