import * as crypto from 'crypto';
import { TenantPoolManager } from '../pool/tenantPoolManager';
import { TenantContext } from '../registry/types';

/**
 * Refresh + password-reset token stores.
 *
 * Fixes the audit gap: the base doc says logout "invalidates the refresh token"
 * and offers /auth/refresh, but defines no table to store or revoke them. Here
 * we store only a SHA-256 hash of each token (never the raw value), support
 * rotation (each refresh revokes the old token and issues a new one), and
 * revocation (logout). Tables live in the tenant DB alongside `users`.
 */

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Opaque, high-entropy token string handed to the client. */
export function newOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export class RefreshTokenStore {
  constructor(private pools: TenantPoolManager) {}

  /** Persist a new refresh token; returns the raw token for the client. */
  async issue(
    ctx: TenantContext,
    userId: string,
    ttlSeconds: number,
  ): Promise<string> {
    const raw = newOpaqueToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.pools.query(
      ctx,
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, sha256(raw), expiresAt],
    );
    return raw;
  }

  /**
   * Rotate: validate the presented token, revoke it, and issue a replacement.
   * Returns the user_id + the new raw token, or null if invalid/expired/revoked.
   * Reuse of an already-rotated token is treated as compromise -> all of that
   * user's tokens are revoked.
   */
  async rotate(
    ctx: TenantContext,
    presentedRaw: string,
    ttlSeconds: number,
  ): Promise<{ userId: string; newToken: string } | null> {
    return this.pools.withTransaction(ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, revoked, expires_at
           FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE`,
        [sha256(presentedRaw)],
      );
      if (rows.length === 0) return null;
      const row = rows[0];

      if (row.revoked) {
        // Token reuse after rotation — revoke everything for this user.
        await client.query(
          `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
          [row.user_id],
        );
        return null;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) return null;

      await client.query(
        `UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1`,
        [row.id],
      );
      const newRaw = newOpaqueToken();
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [row.user_id, sha256(newRaw), new Date(Date.now() + ttlSeconds * 1000)],
      );
      return { userId: row.user_id, newToken: newRaw };
    });
  }

  /** Logout: revoke a single presented token. */
  async revoke(ctx: TenantContext, presentedRaw: string): Promise<void> {
    await this.pools.query(
      ctx,
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
      [sha256(presentedRaw)],
    );
  }

  /** Revoke all of a user's tokens (e.g. after password reset). */
  async revokeAllForUser(ctx: TenantContext, userId: string): Promise<void> {
    await this.pools.query(
      ctx,
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
      [userId],
    );
  }
}

export class PasswordResetStore {
  constructor(private pools: TenantPoolManager) {}

  /** Create a single-use reset token; returns the raw token to email. */
  async create(
    ctx: TenantContext,
    userId: string,
    ttlSeconds: number,
  ): Promise<string> {
    const raw = newOpaqueToken();
    await this.pools.query(
      ctx,
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, sha256(raw), new Date(Date.now() + ttlSeconds * 1000)],
    );
    return raw;
  }

  /** Consume a reset token; returns user_id if valid, else null. Single-use. */
  async consume(ctx: TenantContext, presentedRaw: string): Promise<string | null> {
    return this.pools.withTransaction(ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, user_id, used, expires_at
           FROM password_reset_tokens
          WHERE token_hash = $1
          FOR UPDATE`,
        [sha256(presentedRaw)],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      if (row.used) return null;
      if (new Date(row.expires_at).getTime() < Date.now()) return null;
      await client.query(
        `UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
        [row.id],
      );
      return row.user_id as string;
    });
  }
}
