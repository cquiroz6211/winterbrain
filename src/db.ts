import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AuthIdentity } from './auth.js';

const { Pool } = pg;

const DEFAULT_SCOPES = ['mcp:tools'];
const TOKEN_PREFIX = 'wb';

export interface CreateTokenStoreOptions {
  dbUrl: string;
  adminToken?: string;
}

export interface TokenListItem {
  id: string;
  user_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface TokenVerificationSnapshotItem {
  id: string;
  tokenHash: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

export interface TokenStore {
  list(): Promise<TokenListItem[]>;
  issue(userId: string, ttlSeconds?: number | null, label?: string): Promise<string>;
  revoke(id: string): Promise<boolean>;
  rotate(id: string, ttlSeconds?: number | null): Promise<string | null>;
  verify(plainToken: string): Promise<AuthIdentity | null>;
  snapshotForVerification(): Promise<TokenVerificationSnapshotItem[]>;
  recordTokenUse(id: string): Promise<void>;
  close(): Promise<void>;
}

interface TokenRow {
  id: string;
  token_hash: string;
  user_id: string;
  scopes: string[];
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export async function createTokenStore({ dbUrl }: CreateTokenStoreOptions): Promise<TokenStore> {
  const pool = new Pool({ connectionString: dbUrl });
  await migrate(pool);

  const issue = async (userId: string, ttlSeconds?: number | null, label?: string): Promise<string> => {
    const trimmedUserId = userId.trim();
    if (!trimmedUserId) {
      throw new Error('userId is required');
    }

    const id = randomUUID();
    const plainToken = buildPlainToken(id);
    const tokenHash = hashPlainToken(plainToken);
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;

    await pool.query(
      `INSERT INTO winterbrain_tokens (id, token_hash, user_id, scopes, label, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tokenHash, trimmedUserId, DEFAULT_SCOPES, label?.trim() || null, expiresAt],
    );

    return plainToken;
  };

  return {
    list: async () => {
      const result = await pool.query<TokenRow>(
        `SELECT id, user_id, label, created_at, expires_at, last_used_at
         FROM winterbrain_tokens
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at DESC`,
      );

      return result.rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        label: row.label,
        created_at: toIso(row.created_at),
        expires_at: row.expires_at ? toIso(row.expires_at) : null,
        last_used_at: row.last_used_at ? toIso(row.last_used_at) : null,
      }));
    },

    issue,

    revoke: async (id: string) => {
      const result = await pool.query(
        `UPDATE winterbrain_tokens
         SET revoked_at = now()
         WHERE id = $1
           AND revoked_at IS NULL`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    rotate: async (id: string, ttlSeconds?: number | null) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query<TokenRow>(
          `SELECT user_id, label, expires_at
           FROM winterbrain_tokens
           WHERE id = $1
             AND revoked_at IS NULL
           FOR UPDATE`,
          [id],
        );

        if (current.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }

        const row = current.rows[0];
        const newId = randomUUID();
        const plainToken = buildPlainToken(newId);
        const tokenHash = hashPlainToken(plainToken);
        const expiresAt = resolveRotatedExpiry(row.expires_at, ttlSeconds);

        await client.query(
          `INSERT INTO winterbrain_tokens (id, token_hash, user_id, scopes, label, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [newId, tokenHash, row.user_id, DEFAULT_SCOPES, row.label, expiresAt],
        );

        await client.query(
          `UPDATE winterbrain_tokens
           SET revoked_at = now() + interval '24 hours'
           WHERE id = $1`,
          [id],
        );

        await client.query('COMMIT');
        return plainToken;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    verify: async (plainToken: string) => {
      const tokenHash = hashPlainToken(plainToken);
      const result = await pool.query<TokenRow>(
        `UPDATE winterbrain_tokens
         SET last_used_at = now()
         WHERE token_hash = $1
           AND (revoked_at IS NULL OR revoked_at > now())
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING id, user_id, scopes, expires_at`,
        [tokenHash],
      );

      const row = result.rows[0];
      if (!row) return null;
      return toAuthIdentity(plainToken, row);
    },

    snapshotForVerification: async () => {
      const result = await pool.query<TokenRow>(
        `SELECT id, token_hash, user_id, scopes, expires_at
         FROM winterbrain_tokens
         WHERE (revoked_at IS NULL OR revoked_at > now())
           AND (expires_at IS NULL OR expires_at > now())`,
      );

      return result.rows.map((row) => ({
        id: row.id,
        tokenHash: row.token_hash,
        userId: row.user_id,
        scopes: row.scopes,
        expiresAt: toUnixSeconds(row.expires_at),
      }));
    },

    recordTokenUse: async (id: string) => {
      await pool.query(
        `UPDATE winterbrain_tokens
         SET last_used_at = now()
         WHERE id = $1
           AND (revoked_at IS NULL OR revoked_at > now())
           AND (expires_at IS NULL OR expires_at > now())`,
        [id],
      );
    },

    close: () => pool.end(),
  };
}

export function hashPlainToken(plainToken: string): string {
  return createHash('sha256').update(plainToken).digest('hex');
}

export function extractTokenId(plainToken: string): string | null {
  const match = new RegExp(`^${TOKEN_PREFIX}_([^.]*)\\.`).exec(plainToken);
  return match?.[1] ?? null;
}

async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS winterbrain_tokens (
      id            TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,
      user_id       TEXT NOT NULL,
      scopes        TEXT[] NOT NULL DEFAULT ARRAY['mcp:tools'],
      label         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at    TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ,
      last_used_at  TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS winterbrain_tokens_user_active_idx
      ON winterbrain_tokens(user_id) WHERE revoked_at IS NULL;
  `);
}

function buildPlainToken(id: string): string {
  return `${TOKEN_PREFIX}_${id}.${randomBytes(32).toString('base64url')}`;
}

function toAuthIdentity(plainToken: string, row: Pick<TokenRow, 'user_id' | 'scopes' | 'expires_at'>): AuthIdentity {
  return {
    token: plainToken,
    userId: row.user_id,
    scopes: row.scopes,
    expiresAt: toUnixSeconds(row.expires_at),
  };
}

function toUnixSeconds(value: Date | string | null): number {
  if (!value) return Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10;
  const date = value instanceof Date ? value : new Date(value);
  return Math.floor(date.getTime() / 1000);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function resolveRotatedExpiry(currentExpiresAt: Date | null, ttlSeconds?: number | null): Date | null {
  if (ttlSeconds !== undefined) {
    return ttlSeconds && ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000) : null;
  }

  return currentExpiresAt;
}
