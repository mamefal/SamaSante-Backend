import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middlewares/auth'

export const doctors = new Hono()

doctors.get('/', async (c) => {
  const q = c.req.query('q') || ''
  const list = await prisma.doctor.findMany({
    where: {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { specialty: { contains: q, mode: 'insensitive' } }
      ]
    },
    take: 50
  })
  return c.json(list)
})

const VerifySchema = z.object({
  ordreNumber: z.string().min(3),
  kycScore: z.number().min(0).max(100)
})

doctors.post('/:id/verify',
  requireAuth(['ADMIN']),
  zValidator('json', VerifySchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    const { ordreNumber, kycScore } = c.req.valid('json')
    const d = await prisma.doctor.update({
      where: { id },
      data: { ordreNumber, kycScore, status: 'verified', verifiedAt: new Date() }
    })
    return c.json(d)
  }
)
