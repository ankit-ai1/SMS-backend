import jwt, { JwtPayload } from 'jsonwebtoken';
import { AuthContext, Role } from '../http/context';
import { AppError } from '../http/errors';

/**
 * RS256 JWT issuing + verification.
 *
 * Addresses two audit gaps the base doc left open:
 *  - "where does the public key come from" -> loaded from env (Secret Manager),
 *    never hard-coded.
 *  - "key rotation" -> tokens carry a `kid` header; verification looks the key
 *    up in a keyset, so you can rotate by adding a new key while old tokens
 *    still verify against the previous one. This is JWKS-friendly.
 */

export interface JwtKeys {
  /** Current signing key id. */
  activeKid: string;
  /** PEM private key used to sign (only the active kid needs this). */
  privateKeyPem: string;
  /** kid -> PEM public key, for verification (includes previous keys). */
  publicKeys: Record<string, string>;
  issuer: string;
  accessTtlSeconds: number;
}

export function loadJwtKeysFromEnv(): JwtKeys {
  const activeKid = req('JWT_ACTIVE_KID');
  const privateKeyPem = req('JWT_PRIVATE_KEY_PEM').replace(/\\n/g, '\n');
  // JWT_PUBLIC_KEYS is JSON: { "kid1": "-----BEGIN PUBLIC KEY-----\n..." }
  const publicKeys: Record<string, string> = JSON.parse(req('JWT_PUBLIC_KEYS'));
  for (const k of Object.keys(publicKeys)) {
    publicKeys[k] = publicKeys[k].replace(/\\n/g, '\n');
  }
  return {
    activeKid,
    privateKeyPem,
    publicKeys,
    issuer: process.env.JWT_ISSUER || 'schoolmgmt.com',
    accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL || 3600),
  };
}

export interface AccessClaims extends JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tenant_id: string;
  tenant_slug: string;
  linked_entity_id?: string;
  linked_entity_type?: 'staff' | 'student' | 'guardian';
}

export function signAccessToken(
  keys: JwtKeys,
  claims: {
    userId: string;
    email: string;
    role: Role;
    tenantId: string;
    tenantSlug: string;
    linkedEntityId?: string;
    linkedEntityType?: 'staff' | 'student' | 'guardian';
  },
): { token: string; expiresIn: number } {
  const payload: AccessClaims = {
    sub: claims.userId,
    email: claims.email,
    role: claims.role,
    tenant_id: claims.tenantId,
    tenant_slug: claims.tenantSlug,
    ...(claims.linkedEntityId ? { linked_entity_id: claims.linkedEntityId } : {}),
    ...(claims.linkedEntityType
      ? { linked_entity_type: claims.linkedEntityType }
      : {}),
  };
  const token = jwt.sign(payload, keys.privateKeyPem, {
    algorithm: 'RS256',
    expiresIn: keys.accessTtlSeconds,
    issuer: keys.issuer,
    keyid: keys.activeKid,
  });
  return { token, expiresIn: keys.accessTtlSeconds };
}

/** Verify an access token and map it to the request AuthContext. */
export function verifyAccessToken(keys: JwtKeys, token: string): AuthContext {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    throw AppError.unauthorized('Malformed token');
  }
  const kid = decoded.header.kid;
  const pub = kid ? keys.publicKeys[kid] : undefined;
  if (!pub) {
    throw AppError.unauthorized('Unknown signing key');
  }
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, pub, {
      algorithms: ['RS256'],
      issuer: keys.issuer,
    }) as AccessClaims;
  } catch (err) {
    if ((err as Error).name === 'TokenExpiredError') {
      throw new AppError('TOKEN_EXPIRED', 'Access token has expired');
    }
    throw AppError.unauthorized('Invalid token');
  }
  return {
    userId: claims.sub,
    email: claims.email,
    role: claims.role,
    tenantId: claims.tenant_id,
    tenantSlug: claims.tenant_slug,
    linkedEntityId: claims.linked_entity_id,
    linkedEntityType: claims.linked_entity_type,
  };
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
