import 'hono'

declare module 'hono' {
  // Règle la clé utilisée par c.set('user', ...) et c.get('user')
  interface Variables {
    user: {
      sub: number
      role: 'ADMIN' | 'DOCTOR'| 'PATIENT'
      doctorId?: number | null
      patientId?: number | null
    }
  }
}
