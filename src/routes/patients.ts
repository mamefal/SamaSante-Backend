import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middlewares/auth'

export const patients = new Hono()

const CreatePatient = z.object({
  firstName: z.string(),
  lastName: z.string(),
  dob: z.string().datetime(),
  phone: z.string().optional(),
  email: z.string().email().optional()
})

patients.post('/',
  requireAuth(['DOCTOR','ADMIN']),
  zValidator('json', CreatePatient),
  async (c) => {
    const b = c.req.valid('json')
    const p = await prisma.patient.create({
      data: {
        firstName: b.firstName,
        lastName: b.lastName,
        dob: new Date(b.dob),
        phone: b.phone,
        email: b.email,
        medicalFile: { create: {} }
      }
    })
    return c.json(p)
  }
)
