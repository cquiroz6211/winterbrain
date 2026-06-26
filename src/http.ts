import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { formatBearerChallenge, parseAuthStore, type AuthIdentity } from './auth.js';

export interface HttpGatewayOptions {
  port: number;
  publicUrl: string;
  tokensRaw: string | undefined;
  allowAnonymous: boolean;
}

interface SessionState {
  transport: StreamableHTTPServerTransport;
  identity: AuthIdentity | null;
}

function toAuthInfo(identity: AuthIdentity): AuthInfo {
  return {
    token: identity.token,
    clientId: identity.userId,
    scopes: identity.scopes,
    expiresAt: identity.expiresAt,
    extra: { userId: identity.userId },
  };
}

export async function startHttpGateway(
  serverFactory: () => McpServer,
  options: HttpGatewayOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sessions = new Map<string, SessionState>();
  const authStore = parseAuthStore({ raw: options.tokensRaw, defaultTtlSeconds: 60 * 60 * 24 * 30 });

  const authEnabled = !options.allowAnonymous && authStore.list().length > 0;

  const verifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const identity = await authStore.verify(token);
      if (!identity) {
        throw new InvalidTokenError('Invalid or expired token');
      }
      return toAuthInfo(identity);
    },
  };

  const app = createMcpExpressApp({ host: '0.0.0.0' });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: 'http',
      auth: authEnabled ? 'bearer' : 'anonymous',
      active_sessions: sessions.size,
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: options.publicUrl,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    });
  });

  const bearerAuth = authEnabled
    ? requireBearerAuth({ verifier, requiredScopes: ['mcp:tools'] })
    : null;

  const authenticate = (req: Request, res: Response, next: () => void): void => {
    if (!bearerAuth) {
      next();
      return;
    }
    bearerAuth(req, res, next);
  };

  const handleMcpPost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const reqWithAuth = req as Request & { auth?: AuthInfo };
    const auth = reqWithAuth.auth;
    console.error('[http] POST /mcp sessionId=', sessionId, 'authUser=', typeof auth?.extra?.userId === 'string' ? auth.extra.userId : auth?.clientId, 'body type=', Array.isArray(req.body) ? `array(${req.body.length})` : typeof req.body);
    res.on('close', () => console.error('[http] response closed, status=', res.statusCode, 'sent=', res.headersSent, 'ended=', res.writableEnded));
    console.error('[http] headers content-type=', req.headers['content-type'], 'accept=', req.headers['accept']);

    try {
      let state: SessionState | undefined = sessionId ? sessions.get(sessionId) : undefined;

      if (!state) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: initialize expected' },
            id: null,
          });
          return;
        }

        const identity = auth ? await authStore.verify(auth.token) : null;

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, identity });
            console.error(`[http] session ${newSessionId} initialized for ${identity?.userId ?? 'anonymous'}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        const server = serverFactory();
        await server.connect(transport);
        await transport.handleRequest(reqWithAuth, res, req.body);
        return;
      }

      const transport = state.transport;
      await transport.handleRequest(reqWithAuth, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[http] error handling POST /mcp:', message);
      console.error('[http] stack:', error instanceof Error ? error.stack : 'no-stack');
      console.error('[http] body sent via res.headersSent=', res.headersSent, 'writableEnded=', res.writableEnded);
      if (!res.headersSent) {
        if ((error as Error & { code?: string }).code === 'INVALID_TOKEN') {
          res.set('WWW-Authenticate', formatBearerChallenge(options.publicUrl));
          res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null,
          });
          return;
        }
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const handleMcpGet = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const state = sessions.get(sessionId)!;
    await state.transport.handleRequest(req, res);
  };

  const handleMcpDelete = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const state = sessions.get(sessionId)!;
    await state.transport.handleRequest(req, res);
  };

  app.post('/mcp', authenticate, handleMcpPost);
  app.get('/mcp', authenticate, handleMcpGet);
  app.delete('/mcp', authenticate, handleMcpDelete);

  const port = options.port;
  const httpServer = app.listen(port, () => {
    console.error(`Winterbrain HTTP MCP gateway listening on port ${port}`);
    console.error(`Auth: ${authEnabled ? 'bearer token required' : 'anonymous (set WINTERBRAIN_TOKENS to enable auth)'}`);
    console.error(`Public URL: ${options.publicUrl}`);
  });

  const close = async (): Promise<void> => {
    console.error('[http] shutting down gateway');
    for (const [sessionId, state] of sessions) {
      try {
        await state.transport.close();
      } catch (error) {
        console.error(`[http] error closing session ${sessionId}:`, error);
      }
    }
    sessions.clear();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void close().then(() => process.exit(0));
  });

  return { port, close };
}