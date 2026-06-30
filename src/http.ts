import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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

  mountAdminRoutes(app, {
    adminToken: options.adminToken,
    tokenStore,
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
    res.type('html').send(renderAdminHtml());
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

function renderAdminHtml(): string {
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
    .warning { color: #facc15; font-weight: 700; }
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
    const tokenInput = document.getElementById('admin-token');
    const login = document.getElementById('login');
    const app = document.getElementById('app');
    const message = document.getElementById('message');
    const tbody = document.getElementById('tokens');
    const plainCard = document.getElementById('plain-token-card');
    const plainBox = document.getElementById('plain-token');
    tokenInput.value = localStorage.getItem('winterbrain_admin_token') || '';

    function adminToken() { return localStorage.getItem('winterbrain_admin_token') || tokenInput.value; }
    function showError(text) { message.innerHTML = '<div class="error">' + text + '</div>'; }
    function clearMessage() { message.innerHTML = ''; }
    function fmt(value) { return value ? new Date(value).toLocaleString() : '—'; }
    function esc(value) { return String(value || '—').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }

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
          '<td class="actions"><button class="secondary" data-rotate="' + token.id + '">Rotate</button><button class="danger" data-revoke="' + token.id + '">Revoke</button></td>' +
        '</tr>').join('') || '<tr><td colspan="6" class="muted">No active tokens yet.</td></tr>';
      } catch (error) {
        app.classList.remove('hidden');
        showError(error.message);
      }
    }

    function showPlainToken(value) {
      plainBox.textContent = value;
      plainCard.classList.remove('hidden');
    }

    document.getElementById('save-token').addEventListener('click', () => {
      localStorage.setItem('winterbrain_admin_token', tokenInput.value);
      loadTokens();
    });
    document.getElementById('refresh').addEventListener('click', loadTokens);
    document.getElementById('copy-token').addEventListener('click', () => navigator.clipboard.writeText(plainBox.textContent));
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
