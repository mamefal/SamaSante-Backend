import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma'
import { requireAuth } from '../middlewares/auth'

export const appointments = new Hono()

const CreateAppointment = z.object({
  patientId: z.number(),
  doctorId: z.number(),
  siteId: z.number().optional(),
  motive: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime()
})

appointments.post('/',
  requireAuth(['ADMIN','DOCTOR']),
  zValidator('json', CreateAppointment),
  async (c) => {
    const b = c.req.valid('json')

    const overlap = await prisma.appointment.findFirst({
      where: {
        doctorId: b.doctorId,
        OR: [{ start: { lt: new Date(b.end) }, end: { gt: new Date(b.start) } }],
        status: { in: ['booked'] }
      }
    })
    if (overlap) return c.text('Créneau indisponible (overlap)', 409)

    const appt = await prisma.appointment.create({
      data: {
        patientId: b.patientId,
        doctorId: b.doctorId,
        siteId: b.siteId,
        motive: b.motive,
        start: new Date(b.start),
        end: new Date(b.end),
        source: 'web'
      }
    })
    return c.json(appt)
  }
)

appointments.get('/doctor/:id',
  requireAuth(['ADMIN','DOCTOR']),
  async (c) => {
    const id = Number(c.req.param('id'))
    const list = await prisma.appointment.findMany({
      where: { doctorId: id },
      orderBy: { start: 'asc' },
      take: 100
    })
    return c.json(list)
  }
)
