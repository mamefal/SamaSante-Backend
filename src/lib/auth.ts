import { createHash } from 'crypto'
import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET)

export const hash = (plain: string) =>
  createHash('sha256').update(plain).digest('hex')

export const signJwt = async (payload: object) =>
  await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret)

export const verifyJwt = async (token: string) =>
  (await jwtVerify(token, secret)).payload
