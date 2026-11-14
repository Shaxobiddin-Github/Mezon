import { type UuidV7, parseUuidV7 } from '@mezon/domain';
import { SignJWT, jwtVerify } from 'jose';

export interface CloudJwtPayload {
  readonly sub: UuidV7;
  readonly org: UuidV7;
  readonly role: 'owner' | 'manager';
  readonly name: string;
}

export class CloudJwtService {
  private readonly secretKey: Uint8Array;

  constructor(secret: string) {
    this.secretKey = new TextEncoder().encode(secret);
  }

  async signAccessToken(payload: CloudJwtPayload): Promise<string> {
    return new SignJWT({
      org: payload.org,
      role: payload.role,
      name: payload.name,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuer('mezon-cloud')
      .setAudience('mezon-apps')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.secretKey);
  }

  async verifyAccessToken(token: string): Promise<CloudJwtPayload> {
    const { payload } = await jwtVerify(token, this.secretKey, {
      issuer: 'mezon-cloud',
      audience: 'mezon-apps',
    });

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.org !== 'string' ||
      (payload.role !== 'owner' && payload.role !== 'manager') ||
      typeof payload.name !== 'string'
    ) {
      throw new Error('Invalid JWT claims');
    }

    return {
      sub: parseUuidV7(payload.sub),
      org: parseUuidV7(payload.org),
      role: payload.role,
      name: payload.name,
    };
  }
}
