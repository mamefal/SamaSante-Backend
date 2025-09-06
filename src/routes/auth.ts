import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { hash, signJwt } from '../lib/auth.js'

export const auth = new Hono()

// --- Register ---
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'DOCTOR', 'PATIENT']).default('PATIENT'),
  doctor: z.object({
    firstName: z.string(),
    lastName: z.string(),
    specialty: z.string(),
    ordreNumber: z.string().optional()
  }).optional(),
  // infos minimales patient (optionnelles)
  patient: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dob: z.string().optional(),   // "YYYY-MM-DD"
    phone: z.string().optional()
  }).optional()
}).strict()

auth.post('/register', zValidator('json', RegisterSchema), async (c) => {
  const body = c.req.valid('json')

  // 1) Créer l'utilisateur (+ profil doctor si besoin)
  const user = await prisma.user.create({
    data: {
      email: body.email,
      password: hash(body.password), // hash synchrone (SHA-256)
      role: body.role,
      doctor: body.role === 'DOCTOR' && body.doctor
        ? {
            create: {
              firstName: body.doctor.firstName,
              lastName: body.doctor.lastName,
              specialty: body.doctor.specialty,
              ordreNumber: body.doctor.ordreNumber
            }
          }
        : undefined
    },
    include: { doctor: true }
  })

  // 2) Si PATIENT : lier à un Patient existant (même email) ou créer
  let patientId: number | null = null
  if (body.role === 'PATIENT') {
    let p = await prisma.patient.findFirst({ where: { email: user.email } })
    if (!p) {
      p = await prisma.patient.create({
        data: {
          firstName: body.patient?.firstName ?? user.email.split('@')[0],
          lastName:  body.patient?.lastName  ?? '—',
          dob:       body.patient?.dob ? new Date(body.patient.dob + 'T00:00:00') : new Date('1990-01-01'),
          phone:     body.patient?.phone,
          email:     user.email,
          medicalFile: { create: {} }
        }
      })
    }
    patientId = p.id

    // lier le User au Patient (nécessite User.patientId dans Prisma)
    await prisma.user.update({
      where: { id: user.id },
      data: { patientId }
    })
  }

  const token = await signJwt({
    sub: user.id,
    role: user.role,
    doctorId: user.doctor?.id ?? null,
    patientId
  })

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      doctor: user.doctor,
      patientId
    }
  })
})

// --- Login ---
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
}).strict()

auth.post('/login', zValidator('json', LoginSchema), async (c) => {
  const { email, password } = c.req.valid('json')

  const u = await prisma.user.findUnique({
    where: { email },
    include: { doctor: true }
  })

  if (!u || u.password !== hash(password)) {
    return c.text('Invalid credentials', 401)
  }

  const token = await signJwt({
    sub: u.id,
    role: u.role,
    doctorId: u.doctorId ?? null,
    patientId: u.patientId ?? null
  })

  return c.json({
    token,
    user: {
      id: u.id,
      email: u.email,
      role: u.role,
      doctor: u.doctor,
      patientId: u.patientId ?? null
    }
  })
})
