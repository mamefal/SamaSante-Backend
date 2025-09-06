import type { Context, Next } from 'hono'
import { verifyJwt } from '../lib/auth.js'   

type JwtUser = {
  sub: number
  role: 'ADMIN' | 'DOCTOR'| 'PATIENT'
  doctorId?: number | null
  patientId?: number | null
}

export const requireAuth = (roles?: JwtUser['role'][]) =>
  async (c: Context, next: Next) => {
    const auth = c.req.header('authorization')
    if (!auth?.startsWith('Bearer ')) return c.text('Unauthorized', 401)
    try {
      const payload = await verifyJwt(auth.slice(7)) as JwtUser
      c.set('user', payload)                      // ✅ maintenant typé
      if (roles && !roles.includes(payload.role)) {
        return c.text('Forbidden', 403)
      }
      await next()
    } catch {
      return c.text('Unauthorized', 401)
    }
  }
