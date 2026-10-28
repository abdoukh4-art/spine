import { errors, jwtVerify, SignJWT } from 'jose';
import { UnauthenticatedError } from '../../../platform/errors.js';
import type { Clock, IdGenerator } from '../../../platform/runtime.js';
import type { AccessClaims, AccessTokenService, UserRecord } from '../application/ports.js';
import { isRole } from '../domain/roles.js';

/** JWT issuer and audience (ADR-0016): a token minted for another service is rejected. */
export const JWT_ISSUER = 'spine';
export const JWT_AUDIENCE = 'spine-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Options for {@link JwtAccessTokenService}. */
export interface JwtOptions {
  secret: string;
  ttlSeconds: number;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * HS256 access tokens via `jose` (ADR-0016, RFC 8725).
 *
 * Verification PINS the algorithm list to `['HS256']`. Without that, a token whose header
 * says `alg: none`, or an asymmetric algorithm, could be accepted by a careless verifier:
 * the classic "algorithm confusion" attack. `iss`, `aud` and `exp` are checked against the
 * injected clock, so tests can travel in time.
 */
export class JwtAccessTokenService implements AccessTokenService {
  private readonly key: Uint8Array;

  constructor(private readonly options: JwtOptions) {
    this.key = new TextEncoder().encode(options.secret);
  }

  /** Signs `{sub, role, jti, iat, exp, iss, aud}`. */
  async issue(
    user: Pick<UserRecord, 'id' | 'role'>,
  ): Promise<{ token: string; expiresIn: number }> {
    const nowSeconds = Math.floor(this.options.clock.now().getTime() / 1000);
    const token = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setJti(this.options.ids.next())
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + this.options.ttlSeconds)
      .sign(this.key);
    return { token, expiresIn: this.options.ttlSeconds };
  }

  /** @throws UnauthenticatedError with a generic message for every failure mode. */
  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        requiredClaims: ['sub', 'exp', 'jti'],
        currentDate: this.options.clock.now(),
      });
      const { sub, role, jti } = payload;
      if (typeof sub !== 'string' || !UUID.test(sub) || !isRole(role) || typeof jti !== 'string') {
        throw new UnauthenticatedError('invalid or expired token');
      }
      return { userId: sub, role, tokenId: jti };
    } catch (err) {
      if (err instanceof UnauthenticatedError || err instanceof errors.JOSEError) {
        throw new UnauthenticatedError('invalid or expired token');
      }
      throw err;
    }
  }
}
