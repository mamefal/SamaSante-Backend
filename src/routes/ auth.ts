import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { hash, signJwt } from '../lib/auth'

export const auth = new Hono()

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'DOCTOR']).default('DOCTOR'),
  doctor: z.object({
    firstName: z.string(),
    lastName: z.string(),
    specialty: z.string(),
    ordreNumber: z.string().optional()
  }).optional()
})

auth.post('/register', zValidator('json', RegisterSchema), async (c) => {
  const body = c.req.valid('json')
  const user = await prisma.user.create({
    data: {
      email: body.email,
      password: hash(body.password),
      role: body.role,
      doctor: body.role === 'DOCTOR' && body.doctor ? {
        create: {
          firstName: body.doctor.firstName,
          lastName: body.doctor.lastName,
          specialty: body.doctor.specialty,
          ordreNumber: body.doctor.ordreNumber
        }
      } : undefined
    },
    include: { doctor: true }
  })
  const token = await signJwt({ sub: user.id, role: user.role, doctorId: user.doctor?.id })
  return c.json({ token })
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
})

auth.post('/login', zValidator('json', LoginSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const u = await prisma.user.findUnique({ where: { email } })
  if (!u || u.password !== hash(password)) return c.text('Invalid credentials', 401)
  const token = await signJwt({ sub: u.id, role: u.role, doctorId: u.doctorId })
  return c.json({ token })
})
