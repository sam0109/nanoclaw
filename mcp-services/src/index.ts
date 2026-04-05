/**
 * MCP Services Server — StreamableHTTP entry point.
 *
 * Single Express app exposing POST/GET/DELETE /mcp.
 * Per-session McpServer instances with all CLI-backed tools registered.
 *
 * Agent SDK connects via: { type: 'http', url: 'http://mcp-services:3100/mcp' }
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const PORT = parseInt(process.env.PORT || '3100', 10);

/** Active transports keyed by session ID. */
const transports: Record<string, StreamableHTTPServerTransport> = {};

/** Create a fresh McpServer with all tools registered. */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-services',
    version: '1.0.0',
  });

  // Register CLI-backed tools here as needed

  return server;
}

// ── Express app ─────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── POST /mcp — JSON-RPC messages (init + subsequent) ───────────────

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Existing session
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        console.log(`[mcp-services] Session initialized: ${sid}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        delete transports[sid];
        console.log(`[mcp-services] Session closed: ${sid}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// ── GET /mcp — SSE stream for server-initiated messages ─────────────

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// ── DELETE /mcp — session termination ───────────────────────────────

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// ── Start server ────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-services] Listening on http://0.0.0.0:${PORT}/mcp`);
});

// ── Graceful shutdown ───────────────────────────────────────────────

async function shutdown() {
  console.log('[mcp-services] Shutting down...');
  for (const [sid, transport] of Object.entries(transports)) {
    await transport.close();
    delete transports[sid];
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
