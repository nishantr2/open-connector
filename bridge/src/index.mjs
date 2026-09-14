import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';

const PORT = Number(process.env.PORT || 3000);
const DOWNSTREAM_COMMAND = process.env.DOWNSTREAM_COMMAND || 'npx';
const DOWNSTREAM_ARGS = JSON.parse(process.env.DOWNSTREAM_ARGS || '["-y","@vedalumina/mcp-server"]');
const SERVER_NAME = process.env.MCP_SERVER_NAME || 'etribe-veda-lumina';
const SERVER_VERSION = process.env.MCP_SERVER_VERSION || '0.1.0';
const SHARED_TOKEN = process.env.MCP_SHARED_TOKEN || '';

let downstreamPromise = null;
let downstreamClient = null;

function resetDownstream() {
  downstreamPromise = null;
  downstreamClient = null;
}

async function ensureDownstream() {
  if (downstreamPromise) return downstreamPromise;

  downstreamPromise = (async () => {
    const client = new Client(
      { name: `${SERVER_NAME}-proxy-client`, version: SERVER_VERSION },
      { versionNegotiation: { mode: 'auto' } }
    );
    const transport = new StdioClientTransport({
      command: DOWNSTREAM_COMMAND,
      args: DOWNSTREAM_ARGS
    });

    transport.onclose = () => {
      console.error('[bridge] downstream closed; reconnecting on next request');
      resetDownstream();
    };
    transport.onerror = error => {
      console.error('[bridge] downstream transport error', error);
      resetDownstream();
    };

    await client.connect(transport);
    downstreamClient = client;
    console.error('[bridge] downstream MCP connected');
    return client;
  })().catch(error => {
    resetDownstream();
    throw error;
  });

  return downstreamPromise;
}

async function safeRead(operation) {
  try {
    return await operation(await ensureDownstream());
  } catch (firstError) {
    console.error('[bridge] read operation failed; reconnecting and retrying once', firstError);
    try { await downstreamClient?.close?.(); } catch {}
    resetDownstream();
    return await operation(await ensureDownstream());
  }
}

async function callDownstream(operation) {
  try {
    return await operation(await ensureDownstream());
  } catch (error) {
    console.error('[bridge] tool call failed; not replaying automatically', error);
    resetDownstream();
    throw error;
  }
}

function buildProxyServer() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler('tools/list', async request => {
    const params = request.params?.cursor ? { cursor: request.params.cursor } : undefined;
    return await safeRead(client => client.listTools(params));
  });

  server.setRequestHandler('tools/call', async request => {
    const params = {
      name: request.params.name,
      arguments: request.params.arguments
    };
    return await callDownstream(client => client.callTool(params));
  });

  return server;
}

const mcpHandler = createMcpHandler(buildProxyServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

function authorized(req) {
  if (!SHARED_TOKEN) return true;
  return req.headers.authorization === `Bearer ${SHARED_TOKEN}`;
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: SERVER_NAME }));
    return;
  }

  if (url.pathname === '/readyz') {
    try {
      const result = await safeRead(client => client.listTools());
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, tools: result.tools?.length || 0 }));
    } catch (error) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
    return;
  }

  if (url.pathname !== '/mcp') {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  if (!authorized(req)) {
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Bearer');
    res.end('Unauthorized');
    return;
  }

  void nodeMcpHandler(req, res);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.error(`[bridge] listening on 0.0.0.0:${PORT}`);
});

async function shutdown(signal) {
  console.error(`[bridge] received ${signal}; shutting down`);
  httpServer.close();
  try { await mcpHandler.close(); } catch {}
  try { await downstreamClient?.close?.(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
