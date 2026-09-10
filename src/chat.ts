import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './mcp/tools.ts';
import { makeRateLimiter } from './rateLimit.ts';

export class ChatUnconfiguredError extends Error {}
export class ChatUpstreamError extends Error {}

const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 500;
const MAX_HISTORY = 10;
const MAX_TOOL_ROUNDS = 6;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

export const chatConfigured = (): boolean => Boolean(process.env.DEEPSEEK_API_KEY);

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

type DeepSeekMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

const SYSTEM_PROMPT =
  'You are the assistant for Bandera y Sello, an online souvenir shop selling four kit types '
  + '(flag & seal, capital postcards, currency coin frame, and a collector bundle) for countries '
  + 'worldwide. Use the tools to look up real kits, prices, stock, shipping and country data — '
  + 'never invent a price, stock count or shipping cost. Only create a payment link once the '
  + 'shopper has clearly said they want to buy. Stay focused on this shop; politely decline '
  + 'unrelated requests. '
  + 'This is a chat bubble, not a document. Two or three sentences, straight to the point — say '
  + 'the price and what is in the box, skip the throat-clearing. No markdown: no tables, no '
  + '"**bold**", no bullet lists. Drop the customer-service script — no "I hope this helps," '
  + '"let me know if you need anything," "feel free to ask." A shop selling wax seals and flags '
  + 'from 250 countries can have some personality: be a little playful or opinionated instead of '
  + 'neutral and safe. If a kit is out of stock or does not ship somewhere, just say so plainly.';

async function callDeepSeek(
  key: string,
  messages: DeepSeekMessage[],
  tools: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[],
): Promise<DeepSeekMessage> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: MAX_TOKENS, tools }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((cause: unknown) => {
    throw new ChatUpstreamError(cause instanceof Error ? cause.message : 'chat request failed');
  });

  if (!res.ok) throw new ChatUpstreamError(`deepseek responded ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: DeepSeekMessage }[] };
  const message = body.choices?.[0]?.message;
  if (!message) throw new ChatUpstreamError('deepseek returned no message');
  return message;
}

/**
 * Wires the assistant to the shop's own MCP tools (src/mcp/tools.ts) over an
 * in-memory transport — same tools an external MCP client like Claude Desktop
 * gets, just linked in-process so this needs no extra port or service.
 */
export async function chatReply(message: string, history: ChatMessage[]): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ChatUnconfiguredError('DEEPSEEK_API_KEY is not set');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = buildServer();
  const client = new Client({ name: 'bandera-chat', version: '0.1.0' });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools: mcpTools } = await client.listTools();
    const tools = mcpTools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
    }));

    const messages: DeepSeekMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const reply = await callDeepSeek(key, messages, tools);
      messages.push(reply);
      if (!reply.tool_calls?.length) return reply.content ?? '';

      for (const call of reply.tool_calls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // leave args as {} — a malformed call gets an empty-argument attempt rather than a crash
        }
        const result = await client.callTool({
          name: call.function.name,
          arguments: args as Record<string, unknown>,
        });
        const text = result.content
          .map((c) => (c.type === 'text' ? c.text : `[unsupported content: ${c.type}]`))
          .join('\n');
        messages.push({ role: 'tool', content: text, tool_call_id: call.id });
      }
    }
    throw new ChatUpstreamError('assistant could not finish after several tool calls');
  } finally {
    await client.close();
    await mcp.close();
  }
}

export const allowChat = makeRateLimiter(RATE_LIMIT, RATE_WINDOW_MS);
