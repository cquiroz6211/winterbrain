import express, { type NextFunction, type Request, type Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { formatBearerChallenge, loadAuthStore, type AuthIdentity } from './auth.js';
import { extractTokenId, hashPlainToken, type TokenStore, type TokenVerificationSnapshotItem } from './db.js';

export interface HttpGatewayOptions {
  port: number;
  publicUrl: string;
  tokensRaw: string | undefined;
  dbUrl: string | undefined;
  adminToken: string | undefined;
  installLinkSecret: string | undefined;
  allowAnonymous: boolean;
}

interface SessionState {
  transport: StreamableHTTPServerTransport;
  identity: AuthIdentity | null;
}

type TokenCache = Map<string, TokenVerificationSnapshotItem>;

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
  const authStore = await loadAuthStore({
    raw: options.tokensRaw,
    dbUrl: options.dbUrl,
    adminToken: options.adminToken,
    defaultTtlSeconds: 60 * 60 * 24 * 30,
  });
  const tokenStore = authStore.tokenStore;

  const authEnabled = !options.allowAnonymous && (authStore.mode === 'postgres' || authStore.list().length > 0);
  let tokenCache: TokenCache = new Map();
  let dbStatus: 'ok' | 'disconnected' = tokenStore ? 'disconnected' : 'ok';

  const refreshTokenCache = async (): Promise<void> => {
    if (!tokenStore) return;
    try {
      const snapshot = await tokenStore.snapshotForVerification();
      tokenCache = new Map(snapshot.map((item) => [item.tokenHash, item]));
      dbStatus = 'ok';
    } catch (error) {
      dbStatus = 'disconnected';
      console.error('[http] failed to refresh token cache:', error instanceof Error ? error.message : String(error));
    }
  };

  await refreshTokenCache();
  const cacheRefreshTimer = tokenStore ? setInterval(() => void refreshTokenCache(), 30_000) : null;

  const verifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const identity = tokenStore
        ? verifyFromTokenCache(token, tokenCache, tokenStore)
        : await authStore.verify(token);
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

  app.get('/install/:token', (req: Request, res: Response) => {
    const installToken = readRouteParam(req.params.token);
    const plainToken = resolveInstallToken(installToken, options.installLinkSecret);
    if (!plainToken) {
      res.status(401).type('text').send('Install link expired or invalid');
      return;
    }

    res.type('html').send(renderInstallHtml(options.publicUrl, plainToken));
  });

  mountAdminRoutes(app, {
    adminToken: options.adminToken,
    tokenStore,
    publicUrl: options.publicUrl,
    installLinkSecret: options.installLinkSecret,
    getDbStatus: () => dbStatus,
    getTokenCacheSize: () => tokenCache.size,
    refreshTokenCache,
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

        const identity = auth ? identityFromAuthInfo(auth) : null;

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
    if (cacheRefreshTimer) clearInterval(cacheRefreshTimer);
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
    await authStore.close();
  };

  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void close().then(() => process.exit(0));
  });

  return { port, close };
}

function identityFromAuthInfo(auth: AuthInfo): AuthIdentity {
  const userId = typeof auth.extra?.userId === 'string' ? auth.extra.userId : auth.clientId;
  return {
    token: auth.token,
    userId,
    scopes: auth.scopes,
    expiresAt: auth.expiresAt ?? Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10,
  };
}

function verifyFromTokenCache(token: string, tokenCache: TokenCache, tokenStore: TokenStore): AuthIdentity | null {
  const cached = tokenCache.get(hashPlainToken(token));
  if (!cached) return null;
  if (cached.expiresAt < Math.floor(Date.now() / 1000)) return null;

  void tokenStore.recordTokenUse(cached.id).catch((error) => {
    console.error('[http] failed to update token last_used_at:', error instanceof Error ? error.message : String(error));
  });

  return {
    token,
    userId: cached.userId,
    scopes: cached.scopes,
    expiresAt: cached.expiresAt,
  };
}

interface AdminRouteOptions {
  adminToken: string | undefined;
  tokenStore: TokenStore | null;
  publicUrl: string;
  installLinkSecret: string | undefined;
  getDbStatus(): 'ok' | 'disconnected';
  getTokenCacheSize(): number;
  refreshTokenCache(): Promise<void>;
}

function mountAdminRoutes(app: express.Express, options: AdminRouteOptions): void {
  if (!options.adminToken || !options.tokenStore) {
    app.use('/admin', (_req: Request, res: Response) => {
      res.status(404).send('Not found');
    });
    return;
  }
  const adminToken = options.adminToken;
  const tokenStore = options.tokenStore;

  app.get('/admin', (_req: Request, res: Response) => {
    res.type('html').send(renderAdminHtml(options.publicUrl));
  });

  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    next(error);
  });
  api.use(adminBearerAuth(adminToken));

  api.get('/health', async (_req: Request, res: Response) => {
    const activeTokens = await safeActiveTokenCount(tokenStore, options.getTokenCacheSize());
    res.json({ db: options.getDbStatus(), active_tokens: activeTokens });
  });

  api.get('/tokens', async (_req: Request, res: Response) => {
    res.json({ tokens: await tokenStore.list() });
  });

  api.get('/tokens/:id/install-link', async (req: Request, res: Response) => {
    try {
      if (!options.installLinkSecret) {
        res.status(503).json({ error: 'install_link_secret_not_configured' });
        return;
      }

      const id = readRouteParam(req.params.id);
      const installToken = await tokenStore.getInstallLinkToken(id);
      if (!installToken) {
        res.status(404).json({ error: 'install_link_unavailable_or_expired' });
        return;
      }

      res.json({ link: buildInstallUrl(options.publicUrl, installToken) });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  api.post('/tokens', async (req: Request, res: Response) => {
    try {
      const userId = readString(req.body?.user_id);
      const ttlSeconds = readPositiveInteger(req.body?.ttl_seconds);
      const label = readOptionalString(req.body?.label);

      if (!userId || !ttlSeconds) {
        res.status(400).json({ error: 'user_id and ttl_seconds are required' });
        return;
      }

      const plainToken = await tokenStore.issue(userId, ttlSeconds, label);
      await saveInstallLinkTokenIfConfigured(tokenStore, plainToken, options.installLinkSecret);
      await options.refreshTokenCache();

      const id = extractTokenId(plainToken);
      const token = id ? (await tokenStore.list()).find((item) => item.id === id) : null;
      res.status(201).json({ ...token, id, user_id: userId, plain_token: plainToken });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  api.post('/tokens/:id/revoke', async (req: Request, res: Response) => {
    try {
      const id = readRouteParam(req.params.id);
      const revoked = await tokenStore.revoke(id);
      await options.refreshTokenCache();
      if (!revoked) {
        res.status(404).json({ error: 'token not found or already revoked' });
        return;
      }
      res.json({ id, revoked: true });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  api.post('/tokens/:id/rotate', async (req: Request, res: Response) => {
    try {
      const oldId = readRouteParam(req.params.id);
      const ttlSeconds = req.body?.ttl_seconds === undefined ? undefined : readPositiveInteger(req.body.ttl_seconds);
      if (req.body?.ttl_seconds !== undefined && !ttlSeconds) {
        res.status(400).json({ error: 'ttl_seconds must be a positive integer when provided' });
        return;
      }

      const plainToken = await tokenStore.rotate(oldId, ttlSeconds);
      await options.refreshTokenCache();
      if (!plainToken) {
        res.status(404).json({ error: 'token not found or already revoked' });
        return;
      }

      await saveInstallLinkTokenIfConfigured(tokenStore, plainToken, options.installLinkSecret);

      const id = extractTokenId(plainToken);
      const token = id ? (await tokenStore.list()).find((item) => item.id === id) : null;
      res.json({ ...token, id, plain_token: plainToken });
    } catch (error) {
      sendAdminError(res, error);
    }
  });

  app.use('/admin/api', api);
}

function adminBearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!token || !secureCompare(token, expectedToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function secureCompare(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

async function safeActiveTokenCount(tokenStore: TokenStore, fallback: number): Promise<number> {
  try {
    return (await tokenStore.list()).length;
  } catch {
    return fallback;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? '';
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendAdminError(res: Response, error: unknown): void {
  console.error('[admin] error:', error instanceof Error ? error.stack : String(error));
  res.status(500).json({ error: 'internal_server_error' });
}

const INSTALL_LINK_TTL_SECONDS = 60 * 60 * 24;

interface ClientInstallArtifacts {
  installUrl: string;
  mcpUrl: string;
  userMessage: string;
  claudeDesktopJson: string;
  claudeCodeCommand: string;
  codexCommand: string;
}

function buildInstallUrl(publicUrl: string, tokenOrJwt: string): string {
  return `${publicRoot(publicUrl)}/install/${encodeURIComponent(tokenOrJwt)}`;
}

function publicRoot(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '').replace(/\/mcp$/i, '');
}

function buildClientInstallArtifacts(publicUrl: string, plainToken: string): ClientInstallArtifacts {
  const mcpUrl = `${publicRoot(publicUrl)}/mcp`;
  const installUrl = buildInstallUrl(publicUrl, plainToken);
  return {
    installUrl,
    mcpUrl,
    userMessage: [
      'Winterbrain (cerebro de empresa) ya esta activo.',
      '',
      'Pega esto en Claude o Codex y listo:',
      '',
      installUrl,
      '',
      'El link te configura el cerebro automaticamente.',
    ].join('\n'),
    claudeDesktopJson: JSON.stringify(
      {
        mcpServers: {
          winterbrain: {
            url: mcpUrl,
            headers: { Authorization: `Bearer ${plainToken}` },
          },
        },
      },
      null,
      2,
    ),
    claudeCodeCommand: `claude mcp add --transport http winterbrain ${shellQuote(mcpUrl)} --header ${shellQuote(`Authorization: Bearer ${plainToken}`)}`,
    codexCommand: `codex mcp add winterbrain --url ${shellQuote(mcpUrl)} --bearer-token ${shellQuote(plainToken)}`,
  };
}

async function saveInstallLinkTokenIfConfigured(
  tokenStore: TokenStore,
  plainToken: string,
  secret: string | undefined,
): Promise<void> {
  if (!secret) return;
  const id = extractTokenId(plainToken);
  if (!id) return;
  const issued = createInstallLinkJwt(plainToken, secret);
  await tokenStore.saveInstallLinkToken(id, issued.jwt, issued.expiresAt);
}

function createInstallLinkJwt(plainToken: string, secret: string, nowMs = Date.now()): { jwt: string; expiresAt: Date } {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAtSeconds = issuedAt + INSTALL_LINK_TTL_SECONDS;
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({ token: plainToken, iat: issuedAt, exp: expiresAtSeconds });
  const signingInput = `${header}.${payload}`;
  const signature = signHs256(signingInput, secret);
  return { jwt: `${signingInput}.${signature}`, expiresAt: new Date(expiresAtSeconds * 1000) };
}

function resolveInstallToken(tokenOrJwt: string, secret: string | undefined): string | null {
  if (tokenOrJwt.startsWith('wb_')) return tokenOrJwt;
  if (!secret) return null;

  const parts = tokenOrJwt.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSignature = signHs256(`${encodedHeader}.${encodedPayload}`, secret);
  if (!secureCompare(signature, expectedSignature)) return null;

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: string };
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { token?: unknown; exp?: unknown };
    if (header.alg !== 'HS256') return null;
    if (typeof payload.token !== 'string' || !payload.token.startsWith('wb_')) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload.token;
  } catch {
    return null;
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signHs256(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

function renderInstallHtml(publicUrl: string, plainToken: string): string {
  const artifacts = buildClientInstallArtifacts(publicUrl, plainToken);
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Configurar Winterbrain</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    main { max-width: 840px; margin: 0 auto; padding: 28px 16px 56px; }
    h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 3.5rem); }
    h2 { margin: 0 0 10px; }
    p { line-height: 1.55; }
    .hero, .card { background: #111827; border: 1px solid #334155; border-radius: 18px; padding: 18px; margin: 16px 0; box-shadow: 0 12px 40px rgb(0 0 0 / 0.25); }
    .muted { color: #94a3b8; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    button { cursor: pointer; width: 100%; border: 0; border-radius: 14px; padding: 14px; font: inherit; font-weight: 800; background: #38bdf8; color: #082f49; }
    button.secondary { background: #334155; color: #e2e8f0; }
    button.link { background: transparent; color: #93c5fd; border: 1px solid #334155; margin-top: 8px; }
    pre, .token-box { white-space: pre-wrap; word-break: break-word; background: #020617; border: 1px solid #334155; border-radius: 12px; padding: 12px; color: #e2e8f0; }
    .token-box { border-color: #34d399; background: #022c22; }
    .warning { color: #fde68a; background: #422006; border: 1px solid #f59e0b; border-radius: 12px; padding: 12px; }
    .toast { color: #bbf7d0; background: #14532d; border: 1px solid #22c55e; border-radius: 10px; padding: 10px; margin-top: 12px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Configurar Winterbrain</h1>
      <p>Winterbrain es el cerebro compartido de la empresa. Elegí la app que usás y copiá el bloque listo para pegar.</p>
      <p class="warning">Este link da acceso a Winterbrain. Usalo solo para configurar tu app. Después de configurarlo, el administrador puede revocarlo o rotarlo si hace falta.</p>
      <div id="message"></div>
    </section>

    <section class="grid">
      <article class="card">
        <h2>Claude Desktop</h2>
        <button data-copy="claudeDesktopJson">Copiar para Claude Desktop</button>
        <button class="link" data-toggle="claudeDesktopJson">Ver lo que se va a copiar</button>
        <pre id="claudeDesktopJson" class="hidden">${escapeHtml(artifacts.claudeDesktopJson)}</pre>
      </article>
      <article class="card">
        <h2>Claude Code</h2>
        <button data-copy="claudeCodeCommand">Copiar para Claude Code</button>
        <button class="link" data-toggle="claudeCodeCommand">Ver lo que se va a copiar</button>
        <pre id="claudeCodeCommand" class="hidden">${escapeHtml(artifacts.claudeCodeCommand)}</pre>
      </article>
      <article class="card">
        <h2>Codex CLI</h2>
        <button data-copy="codexCommand">Copiar para Codex CLI</button>
        <button class="link" data-toggle="codexCommand">Ver lo que se va a copiar</button>
        <pre id="codexCommand" class="hidden">${escapeHtml(artifacts.codexCommand)}</pre>
      </article>
    </section>

    <section class="card">
      <h2>Token para copiar manualmente</h2>
      <p class="muted">Usalo solo si tu app te pide pegar el token a mano.</p>
      <div id="plainToken" class="token-box">${escapeHtml(plainToken)}</div>
      <button class="secondary" data-copy="plainToken">Copiar token</button>
    </section>
  </main>
  <script>
    const message = document.getElementById('message');
    async function copyFrom(id) {
      const value = document.getElementById(id).textContent;
      await navigator.clipboard.writeText(value);
      message.innerHTML = '<div class="toast">Copiado. Ahora pegalo en tu app.</div>';
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-copy]');
      if (!button) return;
      copyFrom(button.dataset.copy).catch(() => {
        message.innerHTML = '<div class="warning">No se pudo copiar automaticamente. Seleccioná el bloque y copialo manualmente.</div>';
      });
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-toggle]');
      if (!button) return;
      document.getElementById(button.dataset.toggle).classList.toggle('hidden');
    });
  </script>
</body>
</html>`;
}

function renderAdminHtml(publicUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Winterbrain Admin</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
    h1, h2 { margin: 0 0 12px; }
    .card { background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 16px; margin: 16px 0; box-shadow: 0 12px 40px rgb(0 0 0 / 0.25); }
    label { display: block; font-size: 0.9rem; color: #cbd5e1; margin: 10px 0 6px; }
    input, button { box-sizing: border-box; width: 100%; border-radius: 10px; border: 1px solid #475569; padding: 12px; font: inherit; }
    input { background: #020617; color: #e2e8f0; }
    button { cursor: pointer; background: #38bdf8; color: #082f49; border: 0; font-weight: 700; margin-top: 10px; }
    button.secondary { background: #334155; color: #e2e8f0; }
    button.danger { background: #fb7185; color: #450a0a; }
    .row { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 760px; }
    th, td { border-bottom: 1px solid #334155; padding: 10px; text-align: left; vertical-align: top; }
    th { color: #93c5fd; font-size: 0.85rem; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .actions button { width: auto; padding: 8px 10px; margin: 0; }
    .token-box { background: #022c22; border: 1px solid #34d399; border-radius: 12px; padding: 12px; word-break: break-all; }
    .copy-card { background: #020617; border: 1px solid #334155; border-radius: 12px; padding: 12px; margin-top: 12px; }
    .copy-card h3 { margin: 0 0 8px; font-size: 1rem; color: #bfdbfe; }
    pre.copy-box { white-space: pre-wrap; word-break: break-word; margin: 0; color: #e2e8f0; }
    .warning { color: #facc15; font-weight: 700; }
    .toast { color: #bbf7d0; background: #14532d; border: 1px solid #22c55e; border-radius: 10px; padding: 10px; }
    .error { color: #fecaca; background: #7f1d1d; border: 1px solid #f87171; border-radius: 10px; padding: 10px; }
    .muted { color: #94a3b8; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main>
    <h1>Winterbrain Admin</h1>
    <p class="muted">Manage MCP bearer tokens. Plain tokens are shown once after issue or rotation.</p>

    <section id="login" class="card">
      <h2>Admin login</h2>
      <label for="admin-token">Admin token</label>
      <input id="admin-token" type="password" autocomplete="current-password" placeholder="WINTERBRAIN_ADMIN_TOKEN">
      <button id="save-token">Save token and load</button>
    </section>

    <section id="app" class="hidden">
      <div id="message"></div>

      <section class="card">
        <h2>Issue token</h2>
        <div class="row">
          <div><label for="user-id">User ID</label><input id="user-id" placeholder="sergio"></div>
          <div><label for="ttl">TTL seconds</label><input id="ttl" type="number" min="1" value="3600"></div>
          <div><label for="label">Label</label><input id="label" placeholder="Sergio phone"></div>
        </div>
        <button id="issue">Issue token</button>
      </section>

      <section id="plain-token-card" class="card hidden">
        <h2>Plain token</h2>
        <p class="warning">Copy this now. It will not be shown again.</p>
        <div id="plain-token" class="token-box"></div>
        <button id="copy-token" class="secondary">Copy token</button>
      </section>

      <section id="setup-card" class="card hidden">
        <h2>Material para enviar al usuario</h2>
        <p class="muted">Copiá el mensaje simple para WhatsApp o Slack. Los bloques técnicos quedan listos por si el cliente los pide.</p>
        <div class="copy-card">
          <h3>Mensaje para el usuario</h3>
          <pre id="user-message" class="copy-box"></pre>
          <button class="secondary" data-copy-target="user-message">Copiar</button>
        </div>
        <div class="copy-card">
          <h3>Bloque JSON para Claude Desktop</h3>
          <pre id="claude-desktop-json" class="copy-box"></pre>
          <button class="secondary" data-copy-target="claude-desktop-json">Copiar</button>
        </div>
        <div class="copy-card">
          <h3>Comando para Claude Code (terminal)</h3>
          <pre id="claude-code-command" class="copy-box"></pre>
          <button class="secondary" data-copy-target="claude-code-command">Copiar</button>
        </div>
        <div class="copy-card">
          <h3>Comando para Codex CLI</h3>
          <pre id="codex-command" class="copy-box"></pre>
          <button class="secondary" data-copy-target="codex-command">Copiar</button>
        </div>
      </section>

      <section class="card">
        <h2>Active tokens</h2>
        <button id="refresh" class="secondary">Refresh</button>
        <div class="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Label</th><th>Created</th><th>Expires</th><th>Last used</th><th>Actions</th></tr></thead>
            <tbody id="tokens"></tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
  <script>
    const PUBLIC_URL = ${JSON.stringify(publicUrl)};
    const tokenInput = document.getElementById('admin-token');
    const login = document.getElementById('login');
    const app = document.getElementById('app');
    const message = document.getElementById('message');
    const tbody = document.getElementById('tokens');
    const plainCard = document.getElementById('plain-token-card');
    const plainBox = document.getElementById('plain-token');
    const setupCard = document.getElementById('setup-card');
    const userMessage = document.getElementById('user-message');
    const claudeDesktopJson = document.getElementById('claude-desktop-json');
    const claudeCodeCommand = document.getElementById('claude-code-command');
    const codexCommand = document.getElementById('codex-command');
    tokenInput.value = localStorage.getItem('winterbrain_admin_token') || '';

    function adminToken() { return localStorage.getItem('winterbrain_admin_token') || tokenInput.value; }
    function showError(text) { message.innerHTML = '<div class="error">' + text + '</div>'; }
    function showToast(text) { message.innerHTML = '<div class="toast">' + text + '</div>'; }
    function clearMessage() { message.innerHTML = ''; }
    function fmt(value) { return value ? new Date(value).toLocaleString() : '—'; }
    function esc(value) { return String(value || '—').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }
    function publicRoot() { return PUBLIC_URL.replace(/\/$/, ''); }
    function mcpUrl() { return publicRoot() + '/mcp'; }
    function installUrlForToken(token) { return publicRoot() + '/install/' + encodeURIComponent(token); }
    function shellQuote(value) { return '"' + String(value).replace(/(["\\$])/g, '\\$1') + '"'; }
    async function copyText(text) {
      await navigator.clipboard.writeText(text);
      showToast('Copiado al portapapeles.');
    }

    async function api(path, options = {}) {
      const response = await fetch('/admin/api' + path, {
        ...options,
        headers: {
          'Authorization': 'Bearer ' + adminToken(),
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
      if (response.status === 401) throw new Error('Admin token is invalid. Check WINTERBRAIN_ADMIN_TOKEN.');
      if (!response.ok) throw new Error((await response.json()).error || 'Request failed');
      return response.json();
    }

    async function loadTokens() {
      clearMessage();
      try {
        const data = await api('/tokens');
        login.classList.add('hidden');
        app.classList.remove('hidden');
        tbody.innerHTML = data.tokens.map((token) => '<tr>' +
          '<td>' + esc(token.user_id) + '</td>' +
          '<td>' + esc(token.label) + '</td>' +
          '<td>' + fmt(token.created_at) + '</td>' +
          '<td>' + fmt(token.expires_at) + '</td>' +
          '<td>' + fmt(token.last_used_at) + '</td>' +
          '<td class="actions"><button class="secondary" data-install-link="' + token.id + '">Copiar link de instalación</button><button class="secondary" data-rotate="' + token.id + '">Rotate</button><button class="danger" data-revoke="' + token.id + '">Revoke</button></td>' +
        '</tr>').join('') || '<tr><td colspan="6" class="muted">No active tokens yet.</td></tr>';
      } catch (error) {
        app.classList.remove('hidden');
        showError(error.message);
      }
    }

    function buildArtifacts(token) {
      const installUrl = installUrlForToken(token);
      return {
        message: 'Winterbrain (cerebro de empresa) ya esta activo.\n\nPega esto en Claude o Codex y listo:\n\n' + installUrl + '\n\nEl link te configura el cerebro automaticamente.',
        desktop: JSON.stringify({ mcpServers: { winterbrain: { url: mcpUrl(), headers: { Authorization: 'Bearer ' + token } } } }, null, 2),
        claudeCode: 'claude mcp add --transport http winterbrain ' + shellQuote(mcpUrl()) + ' --header ' + shellQuote('Authorization: Bearer ' + token),
        codex: 'codex mcp add winterbrain --url ' + shellQuote(mcpUrl()) + ' --bearer-token ' + shellQuote(token)
      };
    }

    function showSetupBlocks(token) {
      const artifacts = buildArtifacts(token);
      userMessage.textContent = artifacts.message;
      claudeDesktopJson.textContent = artifacts.desktop;
      claudeCodeCommand.textContent = artifacts.claudeCode;
      codexCommand.textContent = artifacts.codex;
      setupCard.classList.remove('hidden');
    }

    function showPlainToken(value) {
      plainBox.textContent = value;
      plainCard.classList.remove('hidden');
      showSetupBlocks(value);
    }

    document.getElementById('save-token').addEventListener('click', () => {
      localStorage.setItem('winterbrain_admin_token', tokenInput.value);
      loadTokens();
    });
    document.getElementById('refresh').addEventListener('click', loadTokens);
    document.getElementById('copy-token').addEventListener('click', () => copyText(plainBox.textContent));
    setupCard.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-copy-target]');
      if (!button) return;
      const target = document.getElementById(button.dataset.copyTarget);
      await copyText(target.textContent);
    });
    document.getElementById('issue').addEventListener('click', async () => {
      try {
        const data = await api('/tokens', { method: 'POST', body: JSON.stringify({
          user_id: document.getElementById('user-id').value,
          ttl_seconds: Number(document.getElementById('ttl').value),
          label: document.getElementById('label').value
        }) });
        showPlainToken(data.plain_token);
        await loadTokens();
      } catch (error) { showError(error.message); }
    });
    tbody.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      try {
        if (button.dataset.revoke) {
          await api('/tokens/' + button.dataset.revoke + '/revoke', { method: 'POST', body: '{}' });
        }
        if (button.dataset.installLink) {
          const data = await api('/tokens/' + button.dataset.installLink + '/install-link');
          await copyText(data.link);
          return;
        }
        if (button.dataset.rotate) {
          const data = await api('/tokens/' + button.dataset.rotate + '/rotate', { method: 'POST', body: '{}' });
          showPlainToken(data.plain_token);
        }
        await loadTokens();
      } catch (error) { showError(error.message); }
    });
    if (tokenInput.value) loadTokens();
  </script>
</body>
</html>`;
}
