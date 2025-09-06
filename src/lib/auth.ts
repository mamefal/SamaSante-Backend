import { createHash } from 'crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'change-me-super-secret')

/** Hash SHA-256 synchrone (même que le seed) */
export function hash(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

/** Signe un JWT (HS256, exp 1 jour) */
export async function signJwt(payload: JWTPayload | Record<string, unknown>) {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1d')
    .sign(secret)
}

/** Vérifie un JWT et renvoie le payload typé */
export async function verifyJwt(token: string) {
  const { payload } = await jwtVerify(token, secret)
  return payload as { sub: number; role: 'ADMIN' | 'DOCTOR'; doctorId?: number | null }
}
