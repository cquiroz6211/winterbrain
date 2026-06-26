export interface AuthIdentity {
  token: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

export interface AuthStoreOptions {
  raw: string | undefined;
  defaultTtlSeconds: number;
}

const DEFAULT_SCOPES = ['mcp:tools'];

export function parseAuthStore({ raw, defaultTtlSeconds }: AuthStoreOptions): {
  verify(token: string): Promise<AuthIdentity | null>;
  list(): AuthIdentity[];
} {
  const map = new Map<string, AuthIdentity>();
  if (!raw) {
    return {
      verify: async () => null,
      list: () => [],
    };
  }

  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);

  for (const entry of entries) {
    const [tokenPart, rest] = entry.split(':').map((piece) => piece.trim());
    if (!tokenPart || !rest) continue;

    const [userId, scopePart, ttlPart] = rest.split('|').map((piece) => piece.trim());
    if (!userId) continue;

    const scopes = scopePart ? scopePart.split(/\s+/).filter(Boolean) : DEFAULT_SCOPES;
    const ttlSeconds = ttlPart ? Number.parseInt(ttlPart, 10) : defaultTtlSeconds;
    const expiresAt = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? Math.floor(Date.now() / 1000) + ttlSeconds
      : Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;

    map.set(tokenPart, { token: tokenPart, userId, scopes, expiresAt });
  }

  return {
    verify: async (token) => {
      const identity = map.get(token);
      if (!identity) return null;
      if (identity.expiresAt < Math.floor(Date.now() / 1000)) return null;
      return identity;
    },
    list: () => Array.from(map.values()),
  };
}

export function formatBearerChallenge(resourceUrl: string): string {
  return `Bearer realm="winterbrain", resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource"`;
}