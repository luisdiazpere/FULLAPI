/**
 * How a tool reaches the shop.
 *
 * This used to be a fetch() to the shop's own HTTP API, which meant the server called
 * itself over the network — and that stopped working the moment /api/* was closed to
 * everything but the frontend (src/perimeter.ts). Rather than punch an internal hole
 * through that wall, the caller is now injected: the chat supplies an in-process one
 * built on app.inject(), and there is no other transport. Deleting the stdio and HTTP
 * MCP servers is what makes that safe to assume.
 */
export type ShopCall = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export class ShopError extends Error {
  // Fields are declared, not constructor parameters: erasableSyntaxOnly forbids
  // parameter properties, which is also why src/countries.ts:3 stays this plain.
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const detail = (details: unknown, key: string): unknown =>
  details && typeof details === 'object' ? (details as Record<string, unknown>)[key] : undefined;

/**
 * Turn a shop failure into a sentence that tells the model what to do next.
 *
 * A bare "request failed" wastes the whole point of these bodies: they already
 * carry the sku that is short and by how much, so the model can offer a smaller
 * quantity without asking a human.
 */
export function toolError(err: unknown): string {
  if (!(err instanceof ShopError)) {
    return `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
  }

  switch (err.code) {
    case 'kit_unavailable': {
      const sku = detail(err.details, 'kitSku');
      const stock = detail(err.details, 'stock');
      const requested = detail(err.details, 'requested');
      if (stock === 0) {
        return `${sku} is out of stock. Suggest a different kit — call list_kits for what is available.`;
      }
      return `${sku}: only ${stock} in stock but the order asks for ${requested} `
        + `(quantities are summed across every country using that kit). `
        + `Reduce that kit's total to ${stock} or fewer, or drop a line, then try again.`;
    }
    case 'country_not_found':
      return 'No country with that code. Call resolve_country with the name the shopper used.';
    case 'kit_not_found':
      return `No kit with that sku${detail(err.details, 'kitSku') ? ` (${detail(err.details, 'kitSku')})` : ''}. `
        + 'Call list_kits for the valid skus.';
    case 'session_not_found':
      return 'No checkout session with that id. Check the id, or create a new payment link.';
    case 'kit_not_renderable':
      return `${err.message}. That kit cannot be made for that country. Offer a different kit `
        + 'for the same country, or the same kit for a different one.';
    case 'mixed_currency': {
      const currencies = detail(err.details, 'currencies');
      return `One order cannot mix currencies${Array.isArray(currencies) ? ` (${currencies.join(', ')})` : ''}. `
        + 'Split it into one order per currency.';
    }
    case 'shipping_unconfigured':
      return 'Shipping quotes are not configured on this deployment. Say shipping cannot be quoted right now.';
    case 'countries_upstream':
    case 'shipping_upstream':
    case 'stripe_failed':
      return `A provider the shop depends on is temporarily unavailable (${err.code}). `
        + 'Tell the shopper to try again in a moment; do not retry more than once.';
    case 'shop_unreachable':
      return `${err.message}. The shop is probably not running.`;
    case 'invalid_request':
      return `The request was rejected as malformed: ${JSON.stringify(err.details)}. `
        + 'This is a bug in the tool arguments, not something the shopper did.';
    default:
      if (err.status === 503) return 'The shop is offline. Nothing can be looked up or bought right now.';
      return `The shop returned ${err.status} ${err.code}: ${err.message}`;
  }
}
