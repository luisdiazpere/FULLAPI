import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './tools.ts';

// stdout IS the protocol channel here. One stray console.log corrupts the stream
// and the host reports an unparseable message with no clue where it came from.
// Everything in this process logs to stderr or not at all.
await buildServer().connect(new StdioServerTransport());
