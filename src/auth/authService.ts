import { TenantPoolManager } from '../pool/tenantPoolManager';
import { TenantContext } from '../registry/types';
import { AppError } from '../http/errors';
import { Role } from '../http/context';
import { hashPassword, isPasswordAcceptable, verifyPassword } from './passwords';
import {
  JwtKeys,
  signAccessToken,
} from './jwt';
import { PasswordResetStore, RefreshTokenStore } from './tokenStore';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  full_name: string;
  status: string;
  linked_entity_id: string | null;
  linked_entity_type: 'staff' | 'student' | 'guardian' | null;
}

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: {
    id: string;
    email: string;
    role: Role;
    full_name: string;
    tenant_id: string;
  };
}

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const RESET_TTL_SECONDS = 60 * 30; // 30 min

/**
 * Authentication service. Validates credentials against the tenant's `users`
 * table (base doc §7.1: "System Service validates credentials against users
 * table") and issues the RS256 JWT + rotating refresh token.
 */
export class AuthService {
  private refreshStore: RefreshTokenStore;
  private resetStore: PasswordResetStore;

  constructor(
    private pools: TenantPoolManager,
    private keys: JwtKeys,
  ) {
    this.refreshStore = new RefreshTokenStore(pools);
    this.resetStore = new PasswordResetStore(pools);
  }

  private async findByEmail(
    ctx: TenantContext,
    email: string,
  ): Promise<UserRow | null> {
    const { rows } = await this.pools.query<UserRow>(
      ctx,
      `SELECT id, email, password_hash, role, full_name, status,
              linked_entity_id, linked_entity_type
         FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }

  async login(
    ctx: TenantContext,
    email: string,
    password: string,
  ): Promise<LoginResult> {
    const user = await this.findByEmail(ctx, email);
    // Constant-ish response: same error whether user missing or password wrong.
    if (!user || user.status !== 'active') {
      // Still run a hash compare to reduce timing signal.
      await verifyPassword(password, DUMMY_HASH).catch(() => undefined);
      throw AppError.unauthorized('Invalid email or password');
    }
    const okPass = await verifyPassword(password, user.password_hash);
    if (!okPass) throw AppError.unauthorized('Invalid email or password');

    const { token, expiresIn } = signAccessToken(this.keys, {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: ctx.tenant.id,
      tenantSlug: ctx.tenant.slug,
      linkedEntityId: user.linked_entity_id ?? undefined,
      linkedEntityType: user.linked_entity_type ?? undefined,
    });
    const refresh = await this.refreshStore.issue(
      ctx,
      user.id,
      REFRESH_TTL_SECONDS,
    );
    return {
      access_token: token,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        full_name: user.full_name,
        tenant_id: ctx.tenant.id,
      },
    };
  }

  /** Rotate refresh token and mint a new access token. */
  async refresh(
    ctx: TenantContext,
    presentedRefresh: string,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const rotated = await this.refreshStore.rotate(
      ctx,
      presentedRefresh,
      REFRESH_TTL_SECONDS,
    );
    if (!rotated) throw AppError.unauthorized('Invalid or expired refresh token');

    const { rows } = await this.pools.query<UserRow>(
      ctx,
      `SELECT id, email, password_hash, role, full_name, status,
              linked_entity_id, linked_entity_type
         FROM users WHERE id = $1`,
      [rotated.userId],
    );
    const user = rows[0];
    if (!user || user.status !== 'active') {
      throw AppError.unauthorized('User no longer active');
    }
    const { token, expiresIn } = signAccessToken(this.keys, {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: ctx.tenant.id,
      tenantSlug: ctx.tenant.slug,
      linkedEntityId: user.linked_entity_id ?? undefined,
      linkedEntityType: user.linked_entity_type ?? undefined,
    });
    return {
      access_token: token,
      refresh_token: rotated.newToken,
      expires_in: expiresIn,
    };
  }

  async logout(ctx: TenantContext, presentedRefresh: string): Promise<void> {
    await this.refreshStore.revoke(ctx, presentedRefresh);
  }

  async me(ctx: TenantContext, userId: string) {
    const { rows } = await this.pools.query<UserRow>(
      ctx,
      `SELECT id, email, role, full_name, status,
              linked_entity_id, linked_entity_type
         FROM users WHERE id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u) throw AppError.notFound('User');
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      full_name: u.full_name,
      linked_entity_id: u.linked_entity_id,
      linked_entity_type: u.linked_entity_type,
    };
  }

  async changePassword(
    ctx: TenantContext,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    if (!isPasswordAcceptable(newPassword)) {
      throw AppError.validation([
        { field: 'password', message: 'must be at least 8 characters' },
      ]);
    }
    const hash = await hashPassword(newPassword);
    await this.pools.query(
      ctx,
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, userId],
    );
    // Force re-login everywhere after a password change.
    await this.refreshStore.revokeAllForUser(ctx, userId);
  }

  /**
   * Begin password reset. Always resolves the same way whether or not the email
   * exists (no account enumeration). Returns the raw reset token ONLY when a
   * user was found, so the caller can email it; otherwise null.
   */
  async requestPasswordReset(
    ctx: TenantContext,
    email: string,
  ): Promise<string | null> {
    const user = await this.findByEmail(ctx, email);
    if (!user || user.status !== 'active') return null;
    return this.resetStore.create(ctx, user.id, RESET_TTL_SECONDS);
  }

  async resetPassword(
    ctx: TenantContext,
    resetToken: string,
    newPassword: string,
  ): Promise<void> {
    if (!isPasswordAcceptable(newPassword)) {
      throw AppError.validation([
        { field: 'password', message: 'must be at least 8 characters' },
      ]);
    }
    const userId = await this.resetStore.consume(ctx, resetToken);
    if (!userId) throw AppError.unauthorized('Invalid or expired reset token');
    const hash = await hashPassword(newPassword);
    await this.pools.query(
      ctx,
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, userId],
    );
    await this.refreshStore.revokeAllForUser(ctx, userId);
  }
}

// A valid bcrypt hash of a random string, used to equalise timing on the
// "user not found" path. (Never matches any real password.)
const DUMMY_HASH =
  '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3l3l3l3l3l3l3l3l3l3l3l3l3l3l3lC';
