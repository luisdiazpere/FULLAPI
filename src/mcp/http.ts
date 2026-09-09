import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './tools.ts';

const PORT = Number(process.env.MCP_HTTP_PORT ?? 3001);
const ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  if (path !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(rpcError(-32601, 'no such endpoint; the MCP endpoint is POST /mcp'));
  }
  if (req.method !== 'POST') {
    // Stateless mode has no SSE stream to hand out, so say no clearly rather than
    // letting a client hang waiting for one.
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, OPTIONS' });
    return res.end(rpcError(-32601, 'this server is stateless; use POST /mcp'));
  }
  // A browser-reachable endpoint that can call create_payment_link must not be
  // drivable by any page that happens to be open.
  if (origin && !ORIGINS.includes(origin)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(rpcError(-32600, 'origin not allowed'));
  }

  // Stateless: a fresh server and transport per request. Sharing one server across
  // concurrent stateless transports collides request ids.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON rather than SSE frames: every tool here is a short request and
    // response, and it makes the endpoint readable from curl and Postman.
    enableJsonResponse: true,
    // The SDK's own rebinding guard, behind the origin check above.
    enableDnsRebindingProtection: true,
    allowedOrigins: ORIGINS,
    allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? `localhost:${PORT},127.0.0.1:${PORT}`)
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  });
  const mcp = buildServer();
  res.on('close', () => {
    transport.close();
    mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp-http]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(rpcError(-32603, 'internal error'));
    }
  }
});

server.listen(PORT, () => console.error(`[mcp-http] listening on http://localhost:${PORT}/mcp`));
