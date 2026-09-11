import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp/tools.ts';
import type { ShopCall } from '../src/mcp/call.ts';

/**
 * The tools used to reach the shop with fetch(). They now take an injected caller,
 * because /api/* is closed to everything but the frontend and the server calling
 * itself over the network stopped being possible. Nothing else covers that rewiring:
 * a tool that silently stopped talking to the shop would still list fine.
 */
type Recorded = { path: string; init?: { method?: string; body?: unknown } };

function fakeShop(routes: Record<string, unknown>) {
  const calls: Recorded[] = [];
  const call: ShopCall = async <T,>(path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    const key = Object.keys(routes).find((r) => path.startsWith(r));
    if (!key) throw new Error(`no fake route for ${path}`);
    return routes[key] as T;
  };
  return { call, calls };
}

async function connect(call: ShopCall) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ call });
  const client = new Client({ name: 'test', version: '0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const KITS = [
  { sku: 'flag-and-seal', unitAmount: 1800, currency: 'usd', stock: 40, name: 'Flag & Seal Kit - Japan', description: 'A flag. A seal.', purchasable: true, unavailableReason: null },
];

test('every tool is registered and reachable', async () => {
  const { call } = fakeShop({});
  const { client, close } = await connect(call);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'check_payment_status',
    'check_shipping',
    'create_payment_link',
    'list_catalog',
    'list_kits',
    'list_shipping_destinations',
    'resolve_country',
    'search_catalog',
    'validate_cart',
  ]);
  await close();
});

test('a read tool reaches the shop through the injected caller', async () => {
  const { call, calls } = fakeShop({ '/api/kits': KITS });
  const { client, close } = await connect(call);

  const result = await client.callTool({ name: 'list_catalog', arguments: { countryCode: 'JPN' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/api/kits?country=JPN');
  assert.equal(calls[0]!.init, undefined, 'a read must not send a method or body');

  const payload = JSON.parse((result.content as { type: string; text: string }[])[0]!.text);
  assert.equal(payload.countryCode, 'JPN');
  assert.equal(payload.kits[0].sku, 'flag-and-seal');
  await close();
});

test('create_payment_link posts a body rather than putting the cart in the query string', async () => {
  const { call, calls } = fakeShop({
    '/api/checkout': {
      sessionId: 'cs_test_123',
      url: 'https://checkout.example/pay',
      amountTotal: 1800,
      currency: 'usd',
      items: [{ kitSku: 'flag-and-seal', countryCode: 'JPN', quantity: 1, name: 'Flag & Seal Kit - Japan' }],
    },
  });
  const { client, close } = await connect(call);

  await client.callTool({
    name: 'create_payment_link',
    arguments: { items: [{ kitSku: 'flag-and-seal', countryCode: 'JPN', quantity: 1 }] },
  });

  assert.equal(calls[0]!.path, '/api/checkout');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(calls[0]!.init?.body, { items: [{ kitSku: 'flag-and-seal', countryCode: 'JPN', quantity: 1 }] });
  await close();
});

test('a shop failure comes back as guidance, not a stack trace', async () => {
  const call: ShopCall = async () => { throw new Error('boom'); };
  const { client, close } = await connect(call);

  const result = await client.callTool({ name: 'list_kits', arguments: {} });
  assert.equal(result.isError, true);
  const text = (result.content as { type: string; text: string }[])[0]!.text;
  assert.match(text, /Unexpected failure/);
  await close();
});
