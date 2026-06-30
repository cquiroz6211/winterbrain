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
import { extractTokenId, hashPlainToken, type TokenListItem, type TokenStore, type TokenVerificationSnapshotItem } from './db.js';

export interface HttpGatewayOptions {
  port: number;
  publicUrl: string;
  tokensRaw: string | undefined;
  dbUrl: string | undefined;
  adminToken: string | undefined;
  adminCookieSecret: string | undefined;
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
    adminCookieSecret: options.adminCookieSecret,
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
  adminCookieSecret: string | undefined;
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
  const adminCookieSecret = options.adminCookieSecret;
  const tokenStore = options.tokenStore;

  if (!adminCookieSecret) {
    console.error('[admin] WINTERBRAIN_ADMIN_TOKEN is set but WINTERBRAIN_ADMIN_COOKIE_SECRET is missing. Server-rendered /admin is disabled; /admin/api remains available with bearer auth.');
  }

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

  if (!adminCookieSecret) {
    app.use('/admin', (_req: Request, res: Response) => {
      res.status(404).send('Not found');
    });
    return;
  }

  const admin = express.Router();
  admin.use(express.urlencoded({ extended: false, limit: '32kb' }));

  admin.get('/', async (req: Request, res: Response) => {
    const session = readAdminSession(req, adminCookieSecret);
    if (!session) {
      res.type('html').send(renderAdminLoginHtml());
      return;
    }

    const flash = readFlashCookie(req, adminCookieSecret);
    if (flash) {
      clearAdminCookie(res, ADMIN_FLASH_COOKIE_NAME, options.publicUrl);
    }

    try {
      const tokens = await tokenStore.list();
      res.type('html').send(renderAdminDashboardHtml({
        publicUrl: options.publicUrl,
        tokens,
        flash,
      }));
    } catch (error) {
      console.error('[admin] failed to render dashboard:', error instanceof Error ? error.stack : String(error));
      res.status(500).type('html').send(renderAdminDashboardHtml({
        publicUrl: options.publicUrl,
        tokens: [],
        flash: { type: 'error', message: 'No se pudo cargar la lista de tokens.' },
      }));
    }
  });

  admin.post('/login', (req: Request, res: Response) => {
    const submittedToken = extractBearerToken(req) ?? readString(req.body?.admin_token);
    if (!submittedToken || !secureCompare(submittedToken, adminToken)) {
      res.status(401).type('html').send(renderAdminLoginHtml('Token invalido'));
      return;
    }

    setAdminSessionCookie(res, adminCookieSecret, options.publicUrl);
    res.redirect(303, '/admin');
  });

  admin.post('/logout', (req: Request, res: Response) => {
    if (!requireAdminSession(req, res, adminCookieSecret, options.publicUrl)) return;
    clearAdminCookie(res, ADMIN_SESSION_COOKIE_NAME, options.publicUrl);
    clearAdminCookie(res, ADMIN_FLASH_COOKIE_NAME, options.publicUrl);
    res.redirect(303, '/admin');
  });

  admin.post('/tokens', async (req: Request, res: Response) => {
    if (!requireAdminSession(req, res, adminCookieSecret, options.publicUrl)) return;
    try {
      const userId = readString(req.body?.user_id);
      const ttlSeconds = readPositiveInteger(req.body?.ttl_seconds);
      const label = readOptionalString(req.body?.label);

      if (!userId || !ttlSeconds) {
        setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'user_id y ttl_seconds son obligatorios.' });
        res.redirect(303, '/admin');
        return;
      }

      const plainToken = await tokenStore.issue(userId, ttlSeconds, label);
      await saveInstallLinkTokenIfConfigured(tokenStore, plainToken, options.installLinkSecret);
      await options.refreshTokenCache();
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'token', message: 'Token emitido. Copialo ahora: se muestra una sola vez.', plainToken });
      res.redirect(303, '/admin');
    } catch (error) {
      console.error('[admin] issue token failed:', error instanceof Error ? error.stack : String(error));
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'No se pudo emitir el token.' });
      res.redirect(303, '/admin');
    }
  });

  admin.post('/tokens/:id/revoke', async (req: Request, res: Response) => {
    if (!requireAdminSession(req, res, adminCookieSecret, options.publicUrl)) return;
    try {
      const id = readRouteParam(req.params.id);
      const revoked = await tokenStore.revoke(id);
      await options.refreshTokenCache();
      setFlashCookie(res, adminCookieSecret, options.publicUrl, revoked
        ? { type: 'success', message: 'Token revocado.' }
        : { type: 'error', message: 'Token no encontrado o ya revocado.' });
      res.redirect(303, '/admin');
    } catch (error) {
      console.error('[admin] revoke token failed:', error instanceof Error ? error.stack : String(error));
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'No se pudo revocar el token.' });
      res.redirect(303, '/admin');
    }
  });

  admin.post('/tokens/:id/rotate', async (req: Request, res: Response) => {
    if (!requireAdminSession(req, res, adminCookieSecret, options.publicUrl)) return;
    try {
      const oldId = readRouteParam(req.params.id);
      const ttlSeconds = req.body?.ttl_seconds === undefined || req.body.ttl_seconds === '' ? undefined : readPositiveInteger(req.body.ttl_seconds);
      if (req.body?.ttl_seconds !== undefined && req.body.ttl_seconds !== '' && !ttlSeconds) {
        setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'ttl_seconds debe ser un entero positivo.' });
        res.redirect(303, '/admin');
        return;
      }

      const plainToken = await tokenStore.rotate(oldId, ttlSeconds);
      await options.refreshTokenCache();
      if (!plainToken) {
        setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'Token no encontrado o ya revocado.' });
        res.redirect(303, '/admin');
        return;
      }

      await saveInstallLinkTokenIfConfigured(tokenStore, plainToken, options.installLinkSecret);
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'token', message: 'Token rotado. Copialo ahora: se muestra una sola vez.', plainToken });
      res.redirect(303, '/admin');
    } catch (error) {
      console.error('[admin] rotate token failed:', error instanceof Error ? error.stack : String(error));
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'No se pudo rotar el token.' });
      res.redirect(303, '/admin');
    }
  });

  admin.post('/tokens/:id/install-link', async (req: Request, res: Response) => {
    if (!requireAdminSession(req, res, adminCookieSecret, options.publicUrl)) return;
    try {
      if (!options.installLinkSecret) {
        setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'WINTERBRAIN_INSTALL_LINK_SECRET no esta configurado.' });
        res.redirect(303, '/admin');
        return;
      }

      const id = readRouteParam(req.params.id);
      const installToken = await tokenStore.getInstallLinkToken(id);
      if (!installToken) {
        setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'Link de instalacion no disponible o expirado.' });
        res.redirect(303, '/admin');
        return;
      }

      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'install_link', message: 'Link de instalacion listo para copiar.', installLink: buildInstallUrl(options.publicUrl, installToken) });
      res.redirect(303, '/admin');
    } catch (error) {
      console.error('[admin] install link failed:', error instanceof Error ? error.stack : String(error));
      setFlashCookie(res, adminCookieSecret, options.publicUrl, { type: 'error', message: 'No se pudo crear el link de instalacion.' });
      res.redirect(303, '/admin');
    }
  });

  app.use('/admin', admin);
}

const ADMIN_SESSION_COOKIE_NAME = 'winterbrain_admin';
const ADMIN_FLASH_COOKIE_NAME = 'winterbrain_admin_flash';
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 4;
const MAX_FLASH_COOKIE_BYTES = 4096;

interface AdminSessionPayload {
  user: 'admin';
  exp: number;
}

type AdminFlashPayload =
  | { type: 'success'; message: string }
  | { type: 'error'; message: string }
  | { type: 'token'; message: string; plainToken: string }
  | { type: 'install_link'; message: string; installLink: string };

function setAdminSessionCookie(res: Response, secret: string, publicUrl: string): void {
  const payload: AdminSessionPayload = { user: 'admin', exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS };
  setSignedCookie(res, ADMIN_SESSION_COOKIE_NAME, payload, secret, publicUrl, ADMIN_SESSION_TTL_SECONDS);
}

function readAdminSession(req: Request, secret: string): AdminSessionPayload | null {
  const payload = readSignedCookie<AdminSessionPayload>(req, ADMIN_SESSION_COOKIE_NAME, secret);
  if (!payload || payload.user !== 'admin') return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function requireAdminSession(req: Request, res: Response, secret: string, publicUrl: string): boolean {
  if (readAdminSession(req, secret)) return true;
  clearAdminCookie(res, ADMIN_SESSION_COOKIE_NAME, publicUrl);
  res.redirect(303, '/admin');
  return false;
}

function setFlashCookie(res: Response, secret: string, publicUrl: string, flash: AdminFlashPayload): void {
  const cookieValue = createSignedCookieValue(flash, secret);
  if (Buffer.byteLength(`${ADMIN_FLASH_COOKIE_NAME}=${cookieValue}`, 'utf8') > MAX_FLASH_COOKIE_BYTES) {
    setSignedCookie(res, ADMIN_FLASH_COOKIE_NAME, { type: 'error', message: 'El mensaje temporal es demasiado grande para guardarlo.' }, secret, publicUrl, 60);
    return;
  }
  setSignedCookie(res, ADMIN_FLASH_COOKIE_NAME, flash, secret, publicUrl, 60);
}

function readFlashCookie(req: Request, secret: string): AdminFlashPayload | null {
  const payload = readSignedCookie<AdminFlashPayload>(req, ADMIN_FLASH_COOKIE_NAME, secret);
  if (!payload || typeof payload.message !== 'string') return null;
  if (payload.type === 'success' || payload.type === 'error') return payload;
  if (payload.type === 'token' && typeof payload.plainToken === 'string') return payload;
  if (payload.type === 'install_link' && typeof payload.installLink === 'string') return payload;
  return null;
}

function setSignedCookie(res: Response, name: string, payload: unknown, secret: string, publicUrl: string, maxAgeSeconds: number): void {
  res.append('Set-Cookie', serializeCookie(name, createSignedCookieValue(payload, secret), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/admin',
    maxAge: maxAgeSeconds,
    secure: shouldUseSecureCookie(publicUrl),
  }));
}

function clearAdminCookie(res: Response, name: string, publicUrl: string): void {
  res.append('Set-Cookie', serializeCookie(name, '', {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/admin',
    maxAge: 0,
    secure: shouldUseSecureCookie(publicUrl),
  }));
}

function createSignedCookieValue(payload: unknown, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signHs256(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function readSignedCookie<T>(req: Request, name: string, secret: string): T | null {
  const value = parseCookies(req.headers.cookie ?? '')[name];
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!secureCompare(signature, signHs256(encodedPayload, secret))) return null;
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function shouldUseSecureCookie(publicUrl: string): boolean {
  try {
    const hostname = new URL(publicUrl).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return true;
  }
}

interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'Lax';
  path: string;
  maxAge: number;
  secure: boolean;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
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
  const length = Math.max(actualBuffer.length, expectedBuffer.length, 1);
  const paddedActual = Buffer.alloc(length);
  const paddedExpected = Buffer.alloc(length);
  actualBuffer.copy(paddedActual);
  expectedBuffer.copy(paddedExpected);
  return timingSafeEqual(paddedActual, paddedExpected) && actualBuffer.length === expectedBuffer.length;
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

interface AdminDashboardViewModel {
  publicUrl: string;
  tokens: TokenListItem[];
  flash: AdminFlashPayload | null;
}

function renderAdminLoginHtml(error?: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Winterbrain Admin</title>
  <style>${adminCss()}</style>
</head>
<body>
  <main class="login-main">
    <section class="card login-card">
      <h1>Winterbrain Admin</h1>
      <p class="muted">Pega el token admin</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form method="POST" action="/admin/login">
        <label class="sr-only" for="admin-token">Token admin</label>
        <input id="admin-token" name="admin_token" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">Entrar</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function renderAdminDashboardHtml({ publicUrl, tokens, flash }: AdminDashboardViewModel): string {
  const flashHtml = flash ? renderAdminFlash(publicUrl, flash) : '';
  const rows = tokens.map((token) => renderTokenRow(token)).join('') || '<tr><td colspan="7" class="muted">No hay tokens activos.</td></tr>';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Winterbrain Admin</title>
  <style>${adminCss()}</style>
</head>
<body>
  <main>
    <header class="page-header">
      <div>
        <h1>Winterbrain Admin</h1>
        <p class="muted">Administra tokens MCP. Todo funciona sin JavaScript.</p>
      </div>
      <form method="POST" action="/admin/logout"><button class="secondary" type="submit">Salir</button></form>
    </header>

    ${flashHtml}

    <section class="card">
      <h2>Emitir token</h2>
      <form method="POST" action="/admin/tokens" class="grid-form">
        <div><label for="user-id">Usuario</label><input id="user-id" name="user_id" placeholder="sergio" required></div>
        <div><label for="ttl">TTL segundos</label><input id="ttl" name="ttl_seconds" type="number" min="1" value="3600" required></div>
        <div><label for="label">Etiqueta</label><input id="label" name="label" placeholder="Sergio laptop"></div>
        <button type="submit">Emitir token</button>
      </form>
    </section>

    <section class="card">
      <h2>Tokens activos</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Usuario</th><th>Etiqueta</th><th>Creado</th><th>Expira</th><th>Ultimo uso</th><th>Acciones</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-copy-target]');
      if (!button) return;
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = 'Copiado';
      } catch {
        button.textContent = 'Selecciona y copia manualmente';
      }
    });
  </script>
</body>
</html>`;
}

function renderAdminFlash(publicUrl: string, flash: AdminFlashPayload): string {
  if (flash.type === 'error') {
    return `<section class="notice error"><p>${escapeHtml(flash.message)}</p></section>`;
  }
  if (flash.type === 'success') {
    return `<section class="notice success"><p>${escapeHtml(flash.message)}</p></section>`;
  }
  if (flash.type === 'install_link') {
    return `<section class="notice warning"><p>${escapeHtml(flash.message)}</p><pre id="install-link" class="copy-box">${escapeHtml(flash.installLink)}</pre><button class="secondary" type="button" data-copy-target="install-link">Copiar al portapapeles</button></section>`;
  }

  const artifacts = buildClientInstallArtifacts(publicUrl, flash.plainToken);
  return `<section class="notice warning">
    <p>${escapeHtml(flash.message)}</p>
    <h2>Plain token</h2>
    <pre id="plain-token" class="copy-box token-box">${escapeHtml(flash.plainToken)}</pre>
    <button class="secondary" type="button" data-copy-target="plain-token">Copiar al portapapeles</button>
    <h2>Link de instalacion</h2>
    <pre id="new-install-link" class="copy-box">${escapeHtml(artifacts.installUrl)}</pre>
    <button class="secondary" type="button" data-copy-target="new-install-link">Copiar al portapapeles</button>
    <details>
      <summary>Material tecnico opcional</summary>
      <h3>Mensaje para usuario</h3><pre class="copy-box">${escapeHtml(artifacts.userMessage)}</pre>
      <h3>Claude Desktop</h3><pre class="copy-box">${escapeHtml(artifacts.claudeDesktopJson)}</pre>
      <h3>Claude Code</h3><pre class="copy-box">${escapeHtml(artifacts.claudeCodeCommand)}</pre>
      <h3>Codex CLI</h3><pre class="copy-box">${escapeHtml(artifacts.codexCommand)}</pre>
    </details>
  </section>`;
}

function renderTokenRow(token: TokenListItem): string {
  return `<tr>
    <td><code>${escapeHtml(token.id)}</code></td>
    <td>${escapeHtml(token.user_id)}</td>
    <td>${escapeHtml(token.label ?? '—')}</td>
    <td>${escapeHtml(formatDateForAdmin(token.created_at))}</td>
    <td>${escapeHtml(formatDateForAdmin(token.expires_at))}</td>
    <td>${escapeHtml(formatDateForAdmin(token.last_used_at))}</td>
    <td class="actions">
      <form method="POST" action="/admin/tokens/${encodeURIComponent(token.id)}/install-link"><button class="secondary" type="submit">Link instalacion</button></form>
      <form method="POST" action="/admin/tokens/${encodeURIComponent(token.id)}/rotate"><input class="small-input" name="ttl_seconds" type="number" min="1" placeholder="TTL"><button class="secondary" type="submit">Rotar</button></form>
      <form method="POST" action="/admin/tokens/${encodeURIComponent(token.id)}/revoke"><button class="danger" type="submit">Revocar</button></form>
    </td>
  </tr>`;
}

function formatDateForAdmin(value: string | null): string {
  return value ? new Date(value).toLocaleString('es-AR') : '—';
}

function adminCss(): string {
  return `:root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #0f172a; color: #e2e8f0; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
.login-main { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.login-card { width: min(440px, 100%); }
h1, h2, h3 { margin: 0 0 12px; }
.page-header { display: flex; align-items: start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.card, .notice { background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 16px; margin: 16px 0; box-shadow: 0 12px 40px rgb(0 0 0 / 0.25); }
label { display: block; font-size: 0.9rem; color: #cbd5e1; margin: 10px 0 6px; }
input, button { box-sizing: border-box; border-radius: 10px; border: 1px solid #475569; padding: 12px; font: inherit; }
input { width: 100%; background: #020617; color: #e2e8f0; }
button { cursor: pointer; background: #38bdf8; color: #082f49; border: 0; font-weight: 800; }
form > button, .login-card button { width: 100%; margin-top: 10px; }
button.secondary { background: #334155; color: #e2e8f0; }
button.danger { background: #fb7185; color: #450a0a; }
.grid-form { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); align-items: end; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 880px; }
th, td { border-bottom: 1px solid #334155; padding: 10px; text-align: left; vertical-align: top; }
th { color: #93c5fd; font-size: 0.85rem; }
code { font-size: 0.8rem; color: #bae6fd; word-break: break-all; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; min-width: 320px; }
.actions form { display: inline-flex; gap: 6px; align-items: center; }
.actions button { padding: 8px 10px; }
.small-input { width: 90px; padding: 8px; }
.copy-box { white-space: pre-wrap; word-break: break-word; background: #020617; border: 1px solid #334155; border-radius: 12px; padding: 12px; color: #e2e8f0; }
.token-box { border-color: #34d399; background: #022c22; }
.warning { color: #fde68a; background: #422006; border-color: #f59e0b; }
.success { color: #bbf7d0; background: #14532d; border-color: #22c55e; }
.error { color: #fecaca; background: #7f1d1d; border-color: #f87171; }
.muted { color: #94a3b8; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
details { margin-top: 12px; }`;
}
