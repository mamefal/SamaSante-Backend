import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middlewares/auth'

export const availability = new Hono()

const AvailabilitySchema = z.object({
  ruleJson: z.string(),
  siteId: z.number().optional()
})

availability.post('/',
  requireAuth(['DOCTOR']),
  zValidator('json', AvailabilitySchema),
  async (c) => {
    const user = c.get('user') as any
    const body = c.req.valid('json')
    const av = await prisma.availability.create({
      data: {
        doctorId: user.doctorId,
        siteId: body.siteId,
        ruleJson: body.ruleJson
      }
    })
    return c.json(av)
  }
)

availability.get('/me',
  requireAuth(['DOCTOR']),
  async (c) => {
    const user = c.get('user') as any
    const list = await prisma.availability.findMany({ where: { doctorId: user.doctorId } })
    return c.json(list)
  }
)
