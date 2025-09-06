// src/routes/public.ts
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { getDailySlots, isBookable } from '../lib/slots.js'

export const pub = new Hono()

// --- Règles (.env) ---
const MIN_BOOK_AHEAD_MIN = parseInt(process.env.MIN_BOOK_AHEAD_MIN ?? '60', 10)

function minutesUntil(dateIso: string | Date) {
  const t = typeof dateIso === 'string' ? new Date(dateIso) : dateIso
  return Math.floor((+t - Date.now()) / 60000)
}

/** 1) Créer un patient (public) */
const CreatePatient = z.object({
  firstName: z.string(),
  lastName: z.string(),
  dob: z.string().date().or(z.string().datetime()), // accepte "YYYY-MM-DD" ou ISO
  phone: z.string().optional(),
  email: z.string().email().optional()
})
pub.post('/patients', zValidator('json', CreatePatient), async (c) => {
  const b = c.req.valid('json')
  const dob = b.dob.length === 10 ? new Date(b.dob + 'T00:00:00') : new Date(b.dob)
  const p = await prisma.patient.create({
    data: {
      firstName: b.firstName,
      lastName: b.lastName,
      dob,
      phone: b.phone,
      email: b.email,
      medicalFile: { create: {} }
    }
  })
  return c.json(p)
})

/** 2) Rechercher un médecin (public) — même logique que /api/doctors */
pub.get('/doctors', async (c) => {
  const q = c.req.query('q') || ''
  const list = await prisma.doctor.findMany({
    where: {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { specialty: { contains: q, mode: 'insensitive' } }
      ]
    },
    take: 50,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
  })
  return c.json(list)
})

/** 3) Lister les créneaux dispo d'un médecin pour une date */
const SlotsQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.coerce.number().min(5).max(120).default(20),
  siteId: z.coerce.number().optional()
})
pub.get('/doctors/:id/slots', zValidator('query', SlotsQuery), async (c) => {
  const doctorId = Number(c.req.param('id'))
  const { date, durationMinutes, siteId } = c.req.valid('query')
  const slots = await getDailySlots({ doctorId, date, durationMinutes, siteId })
  return c.json({ doctorId, date, slots })
})

/** 4) Réserver un créneau (public) */
const BookSchema = z.object({
  patientId: z.number(),
  doctorId: z.number(),
  siteId: z.number().optional(),
  motive: z.string().default('Consultation'),
  start: z.string().datetime(),
  end: z.string().datetime(),
  durationMinutes: z.number().optional()
})
pub.post('/appointments', zValidator('json', BookSchema), async (c) => {
  const b = c.req.valid('json')

  // 4.a Délai minimum avant le début
  if (minutesUntil(b.start) < MIN_BOOK_AHEAD_MIN) {
    return c.text(`Réservation refusée : délai minimum ${MIN_BOOK_AHEAD_MIN} min`, 409)
  }

  // 4.b Vérifier que le créneau respecte les règles de dispo
  const ok = await isBookable({
    doctorId: b.doctorId,
    startISO: b.start,
    endISO: b.end,
    durationMinutes: b.durationMinutes ?? 20,
    siteId: b.siteId
  })
  if (!ok) return c.text('Créneau indisponible', 409)

  // 4.c Double check (chevauchement) contre RDV existants
  const overlap = await prisma.appointment.findFirst({
    where: {
      doctorId: b.doctorId,
      status: { in: ['booked'] },
      AND: [{ start: { lt: new Date(b.end) } }, { end: { gt: new Date(b.start) } }]
    }
  })
  if (overlap) return c.text('Créneau déjà pris', 409)

  // 4.d Créer le RDV
  const appt = await prisma.appointment.create({
    data: {
      patientId: b.patientId,
      doctorId: b.doctorId,
      siteId: b.siteId ?? null,
      motive: b.motive,
      start: new Date(b.start),
      end: new Date(b.end),
      source: 'mobile',
      status: 'booked'
    }
  })
  return c.json(appt)
})

/** 5) Prochaine disponibilité (public) — max +30 jours */
pub.get('/doctors/:id/next-availability', async (c) => {
  const doctorId = Number(c.req.param('id'))
  const dateFrom = c.req.query('from') || new Date().toISOString().slice(0, 10)
  const durationMinutes = c.req.query('durationMinutes') ? Number(c.req.query('durationMinutes')) : 20
  const siteId = c.req.query('siteId') ? Number(c.req.query('siteId')) : undefined

  const start = new Date(dateFrom + 'T00:00:00')
  for (let i = 0; i < 30; i++) {
    const d = new Date(+start + i * 24 * 60 * 60 * 1000)
    const ymd = d.toISOString().slice(0, 10)
    const slots = await getDailySlots({ doctorId, date: ymd, durationMinutes, siteId })
    if (slots.length) return c.json({ doctorId, date: ymd, slot: slots[0] })
  }
  return c.text('Aucune disponibilité trouvée sur 30 jours', 404)
})

/// GET /api/public/doctors/:id/week-slots?from=YYYY-MM-DD&durationMinutes=20&siteId=...&hidePast=true
const WeekSlotsQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(new Date().toISOString().slice(0, 10)),
    durationMinutes: z.coerce.number().min(5).max(120).default(20),
    siteId: z.coerce.number().optional(),
    hidePast: z.coerce.boolean().default(true) // filtre les créneaux passés (et < délai mini)
  })
  
  pub.get('/doctors/:id/week-slots', zValidator('query', WeekSlotsQuery), async (c) => {
    const doctorId = Number(c.req.param('id'))
    if (Number.isNaN(doctorId)) return c.text('doctorId invalide', 400)
    const { from, durationMinutes, siteId, hidePast } = c.req.valid('query')
  
    const start = new Date(from + 'T00:00:00')
    const now = new Date()
    const minAheadMs = (MIN_BOOK_AHEAD_MIN ?? 0) * 60 * 1000
  
    const days: { date: string; slots: { start: string; end: string; durationMinutes: number }[] }[] = []
  
    for (let i = 0; i < 7; i++) {
      const d = new Date(+start + i * 86400000)
      const ymd = d.toISOString().slice(0, 10)
  
      let slots = await getDailySlots({ doctorId, date: ymd, durationMinutes, siteId })
  
      if (hidePast) {
        // garde uniquement les créneaux dont le début est >= maintenant + délai mini
        slots = slots.filter(s => (new Date(s.start).getTime() - now.getTime()) >= minAheadMs)
      }
  
      days.push({ date: ymd, slots })
    }
  
    return c.json({
      doctorId,
      from,
      to: new Date(+start + 6 * 86400000).toISOString().slice(0, 10),
      days
    })
  })
  
