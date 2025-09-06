// src/routes/appointments.ts
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middlewares/auth.js'
import { getDailySlots, isBookable } from '../lib/slots.js'


export const appointments = new Hono()

// --- Règles métier paramétrables (.env) ---
const MIN_BOOK_AHEAD_MIN = parseInt(process.env.MIN_BOOK_AHEAD_MIN ?? '60', 10)       // min avant prise/modif
const MIN_CANCEL_AHEAD_MIN = parseInt(process.env.MIN_CANCEL_AHEAD_MIN ?? '120', 10)  // min avant annulation

// --- Helpers date ---
function startOfDay(dateStr?: string) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
function endOfDay(dateStr?: string) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date()
  d.setHours(23, 59, 59, 999)
  return d
}
function minutesUntil(dateIso: string | Date) {
  const t = typeof dateIso === 'string' ? new Date(dateIso) : dateIso
  return Math.floor((+t - Date.now()) / 60000)
}
function ymdLocal(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// -------------------------
// 1) Création de RDV (médecin/admin)
// -------------------------
const CreateAppointment = z.object({
  patientId: z.number(),
  doctorId: z.number(),
  siteId: z.number().optional(),
  motive: z.string(),
  start: z.string().datetime(),
  end: z.string().datetime()
})

appointments.post('/',
  requireAuth(['ADMIN', 'DOCTOR']),
  zValidator('json', CreateAppointment),
  async (c) => {
    const b = c.req.valid('json')

    // délai mini avant début
    if (minutesUntil(b.start) < MIN_BOOK_AHEAD_MIN) {
      return c.text(`Réservation refusée : délai minimum ${MIN_BOOK_AHEAD_MIN} min`, 409)
    }

    // respect des règles de disponibilité
    const ok = await isBookable({
      doctorId: b.doctorId,
      startISO: b.start,
      endISO: b.end,
      durationMinutes: 20,
      siteId: b.siteId
    })
    if (!ok) return c.text('Créneau indisponible selon les règles', 409)

    // chevauchement strict
    const overlap = await prisma.appointment.findFirst({
      where: {
        doctorId: b.doctorId,
        status: { in: ['booked'] },
        AND: [{ start: { lt: new Date(b.end) } }, { end: { gt: new Date(b.start) } }]
      }
    })
    if (overlap) return c.text('Créneau indisponible (overlap)', 409)

    const appt = await prisma.appointment.create({
      data: {
        patientId: b.patientId,
        doctorId: b.doctorId,
        siteId: b.siteId ?? null,
        motive: b.motive,
        start: new Date(b.start),
        end: new Date(b.end),
        source: 'web',
        status: 'booked'
      }
    })
    return c.json(appt)
  }
)

// -------------------------
// 2) Lister les RDV d’un médecin
// -------------------------
appointments.get('/doctor/:id',
  requireAuth(['ADMIN', 'DOCTOR']),
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

// -------------------------
// 3) RDV du jour (dashboard médecin)
// -------------------------
appointments.get('/today',
  requireAuth(['DOCTOR', 'ADMIN']),
  async (c) => {
    const user = c.get('user')
    const doctorId = c.req.query('doctorId') ? Number(c.req.query('doctorId')) : user.doctorId
    if (!doctorId) return c.text('doctorId requis', 400)

    const qDate = c.req.query('date') ?? undefined
    const from = startOfDay(qDate)
    const to = endOfDay(qDate)

    const list = await prisma.appointment.findMany({
      where: { doctorId, start: { gte: from }, end: { lte: to } },
      include: { patient: true },
      orderBy: { start: 'asc' }
    })
    return c.json({ doctorId, date: (qDate ?? ymdLocal(new Date())), items: list })
  }
)

// -------------------------
// 4) Replanifier (patient OU médecin)
// -------------------------
const RescheduleSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  durationMinutes: z.number().optional(),
  siteId: z.number().optional()
})

appointments.patch('/:id/reschedule',
  requireAuth(['DOCTOR', 'PATIENT']),
  zValidator('json', RescheduleSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    const { start, end, durationMinutes, siteId } = c.req.valid('json')
    const user = c.get('user')

    const appt = await prisma.appointment.findUnique({ where: { id } })
    if (!appt) return c.text('Not found', 404)

    // autorisations
    if (
      (user.role === 'DOCTOR' && user.doctorId !== appt.doctorId) ||
      (user.role === 'PATIENT' && user.patientId !== appt.patientId)
    ) {
      return c.text('Forbidden', 403)
    }

    // délai mini avant la nouvelle heure
    if (minutesUntil(start) < MIN_BOOK_AHEAD_MIN) {
      return c.text(`Replanification refusée : délai minimum ${MIN_BOOK_AHEAD_MIN} min`, 409)
    }

    // respect des règles de dispo
    const ok = await isBookable({
      doctorId: appt.doctorId,
      startISO: start,
      endISO: end,
      durationMinutes: durationMinutes ?? 20,
      siteId
    })
    if (!ok) return c.text('Créneau indisponible selon les règles', 409)

    // chevauchement (autres RDV)
    const overlap = await prisma.appointment.findFirst({
      where: {
        id: { not: id },
        doctorId: appt.doctorId,
        status: { in: ['booked'] },
        AND: [{ start: { lt: new Date(end) } }, { end: { gt: new Date(start) } }]
      }
    })
    if (overlap) return c.text('Créneau indisponible (overlap)', 409)

    // ✅ update unique après tous les contrôles
    const updated = await prisma.appointment.update({
      where: { id },
      data: {
        start: new Date(start),
        end: new Date(end),
        siteId: siteId ?? appt.siteId,
        status: (appt.status === 'cancelled' || appt.status === 'no_show') ? 'booked' : appt.status
      }
    })
    return c.json(updated)
  }
)

// -------------------------
// 5) Annuler (patient OU médecin)
// -------------------------
appointments.patch('/:id/cancel',
  requireAuth(['DOCTOR', 'PATIENT']),
  async (c) => {
    const id = Number(c.req.param('id'))
    const user = c.get('user')

    const appt = await prisma.appointment.findUnique({ where: { id } })
    if (!appt) return c.text('Not found', 404)

    if (
      (user.role === 'DOCTOR' && user.doctorId !== appt.doctorId) ||
      (user.role === 'PATIENT' && user.patientId !== appt.patientId)
    ) {
      return c.text('Forbidden', 403)
    }

    // règle patient : pas d'annulation trop tard
    if (user.role === 'PATIENT' && minutesUntil(appt.start) < MIN_CANCEL_AHEAD_MIN) {
      return c.text(`Annulation refusée : délai minimum ${MIN_CANCEL_AHEAD_MIN} min`, 409)
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'cancelled' }
    })
    return c.json(updated)
  }
)

// -------------------------
// 6) Marquer "done" (médecin)
// -------------------------
appointments.patch('/:id/done',
  requireAuth(['DOCTOR']),
  async (c) => {
    const id = Number(c.req.param('id'))
    const user = c.get('user')

    const appt = await prisma.appointment.findUnique({ where: { id } })
    if (!appt) return c.text('Not found', 404)
    if (user.doctorId !== appt.doctorId) return c.text('Forbidden', 403)

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'done' }
    })
    return c.json(updated)
  }
)

// -------------------------
// 7) Marquer "no_show" (médecin)
// -------------------------
appointments.patch('/:id/no-show',
  requireAuth(['DOCTOR']),
  async (c) => {
    const id = Number(c.req.param('id'))
    const user = c.get('user')

    const appt = await prisma.appointment.findUnique({ where: { id } })
    if (!appt) return c.text('Not found', 404)
    if (user.doctorId !== appt.doctorId) return c.text('Forbidden', 403)

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'no_show' }
    })
    return c.json(updated)
  }
)

// -------------------------
// 8) Mes RDV (patient connecté)
// -------------------------
appointments.get('/my',
  requireAuth(['PATIENT']),
  async (c) => {
    const { patientId } = c.get('user')
    if (!patientId) return c.text('Profile incomplet', 400)

    const list = await prisma.appointment.findMany({
      where: { patientId },
      include: { doctor: true },
      orderBy: { start: 'asc' }
    })

    return c.json(list)
  }
)

// -------------------------
// 9) Agenda hebdo médecin
// -------------------------
appointments.get('/doctor/:id/week',
  requireAuth(['ADMIN', 'DOCTOR']),
  async (c) => {
    const user = c.get('user')
    const doctorId = Number(c.req.param('id'))
    if (Number.isNaN(doctorId)) return c.text('doctorId invalide', 400)
    if (user.role === 'DOCTOR' && user.doctorId !== doctorId) return c.text('Forbidden', 403)

    const fromStr = c.req.query('from') || ymdLocal(new Date())
    const from = startOfDay(fromStr)
    const toDate = addDays(from, 6)
    const to = endOfDay(ymdLocal(toDate))

    const appts = await prisma.appointment.findMany({
      where: { doctorId, start: { gte: from }, end: { lte: to } },
      include: { patient: true },
      orderBy: { start: 'asc' }
    })

    // groupe par date locale
    const days: Record<string, typeof appts> = {}
    for (let i = 0; i < 7; i++) {
      const d = ymdLocal(addDays(from, i))
      days[d] = []
    }
    for (const a of appts) {
      const d = ymdLocal(a.start)
      if (!days[d]) days[d] = []
      days[d].push(a)
    }

    const out = Object.entries(days).map(([date, items]) => ({ date, items }))
    return c.json({ doctorId, from: ymdLocal(from), to: ymdLocal(toDate), days: out })
  }
)

// -------------------------
// 10) KPIs /stats (semaine ou plage libre)
// -------------------------
appointments.get('/doctor/:id/stats',
  requireAuth(['ADMIN','DOCTOR']),
  async (c) => {
    const user = c.get('user')
    const doctorId = Number(c.req.param('id'))
    if (Number.isNaN(doctorId)) return c.text('doctorId invalide', 400)
    if (user.role === 'DOCTOR' && user.doctorId !== doctorId) return c.text('Forbidden', 403)

    const fromStr = c.req.query('from') || ymdLocal(new Date())
    const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
    const from = startOfDay(fromStr)
    const to = endOfDay(toStr)

    const appts = await prisma.appointment.findMany({
      where: { doctorId, start: { gte: from }, end: { lte: to } },
      select: { id: true, status: true, start: true, end: true, patientId: true },
      orderBy: { start: 'asc' }
    })

    const kpis: Record<'booked'|'done'|'cancelled'|'no_show', number> =
      { booked: 0, done: 0, cancelled: 0, no_show: 0 }

    let minutesBooked = 0
    let minutesDone = 0
    let firstAt: Date | null = null
    let lastAt: Date | null = null
    const patientIds = new Set<number>()
    let totalDuration = 0

    for (const a of appts) {
      kpis[a.status]++
      const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
      totalDuration += dur
      if (a.status === 'done' || a.status === 'booked') minutesBooked += dur
      if (a.status === 'done') minutesDone += dur
      if (!firstAt) firstAt = a.start
      lastAt = a.end
      patientIds.add(a.patientId)
    }

    const total = appts.length
    const noShowRate = total ? Number(((kpis.no_show / total) * 100).toFixed(1)) : 0
    const cancelRate = total ? Number(((kpis.cancelled / total) * 100).toFixed(1)) : 0
    const avgApptMinutes = total ? Math.round(totalDuration / total) : 0

    const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined
    const revenueEstimatedCFA = feeCFA ? kpis.done * feeCFA : undefined

    return c.json({
      doctorId,
      from: ymdLocal(from),
      to: ymdLocal(to),
      totalAppointments: total,
      kpis,
      minutesBooked,
      minutesDone,
      avgApptMinutes,
      uniquePatients: patientIds.size,
      noShowRate,
      cancelRate,
      firstAt,
      lastAt,
      revenueEstimatedCFA
    })
  }
)

// -------------------------
// 11) Timeseries journalière /stats/daily
// -------------------------
appointments.get('/doctor/:id/stats/daily',
  requireAuth(['ADMIN','DOCTOR']),
  async (c) => {
    const user = c.get('user')
    const doctorId = Number(c.req.param('id'))
    if (Number.isNaN(doctorId)) return c.text('doctorId invalide', 400)
    if (user.role === 'DOCTOR' && user.doctorId !== doctorId) return c.text('Forbidden', 403)

    const fromStr = c.req.query('from') || ymdLocal(new Date())
    const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
    const from = startOfDay(fromStr)
    const to = endOfDay(toStr)

    const appts = await prisma.appointment.findMany({
      where: { doctorId, start: { gte: from }, end: { lte: to } },
      select: { status: true, start: true, end: true },
      orderBy: { start: 'asc' }
    })

    const days: Record<string, {
      booked: number; done: number; cancelled: number; no_show: number;
      minutesBooked: number; minutesDone: number;
    }> = {}

    const cursor = new Date(from)
    while (cursor <= to) {
      const k = ymdLocal(cursor)
      days[k] = { booked: 0, done: 0, cancelled: 0, no_show: 0, minutesBooked: 0, minutesDone: 0 }
      cursor.setDate(cursor.getDate() + 1)
    }

    for (const a of appts) {
      const k = ymdLocal(a.start)
      const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
      if (!days[k]) {
        days[k] = { booked: 0, done: 0, cancelled: 0, no_show: 0, minutesBooked: 0, minutesDone: 0 }
      }
      days[k][a.status]++
      if (a.status === 'done' || a.status === 'booked') days[k].minutesBooked += dur
      if (a.status === 'done') days[k].minutesDone += dur
    }

    const series = Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }))

    return c.json({
      doctorId,
      from: ymdLocal(from),
      to: ymdLocal(to),
      days: series
    })
  }
)

// -------------------------
// 12) Dashboard du jour (médecin)
// -------------------------
// GET /api/appointments/doctor/:id/dashboard?date=YYYY-MM-DD&durationMinutes=20&feeCFA=25000
appointments.get('/doctor/:id/dashboard',
    requireAuth(['ADMIN','DOCTOR']),
    async (c) => {
      const user = c.get('user')
      const doctorId = Number(c.req.param('id'))
      if (Number.isNaN(doctorId)) return c.text('doctorId invalide', 400)
      if (user.role === 'DOCTOR' && user.doctorId !== doctorId) return c.text('Forbidden', 403)
  
      const qDate = c.req.query('date') || ymdLocal(new Date())
      const durationMinutes = c.req.query('durationMinutes') ? Number(c.req.query('durationMinutes')) : 20
      const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined
  
      const from = startOfDay(qDate)
      const to = endOfDay(qDate)
  
      // 1) RDV du jour
      const items = await prisma.appointment.findMany({
        where: { doctorId, start: { gte: from }, end: { lte: to } },
        include: { patient: true },
        orderBy: { start: 'asc' }
      })
  
      // 2) KPIs du jour
      const kpis: Record<'booked'|'done'|'cancelled'|'no_show', number> =
        { booked: 0, done: 0, cancelled: 0, no_show: 0 }
      let minutesBooked = 0
      let minutesDone = 0
      let totalDuration = 0
      const patientIds = new Set<number>()
      let firstAt: Date | null = null
      let lastAt: Date | null = null
  
      for (const a of items) {
        kpis[a.status]++
        const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
        totalDuration += dur
        if (a.status === 'done' || a.status === 'booked') minutesBooked += dur
        if (a.status === 'done') minutesDone += dur
        if (!firstAt) firstAt = a.start
        lastAt = a.end
        patientIds.add(a.patientId)
      }
  
      const total = items.length
      const noShowRate = total ? Number(((kpis.no_show / total) * 100).toFixed(1)) : 0
      const cancelRate = total ? Number(((kpis.cancelled / total) * 100).toFixed(1)) : 0
      const avgApptMinutes = total ? Math.round(totalDuration / total) : 0
      const revenueEstimatedCFA = feeCFA ? kpis.done * feeCFA : undefined
  
      // 3) Prochain RDV
      const now = new Date()
      let nextAppointment = null as null | {
        id: number; start: Date; end: Date; patient: { id: number; firstName: string; lastName: string }
      }
      // si c’est la date du jour => prochain "booked" >= maintenant, sinon premier "booked" du jour
      const isToday = qDate === ymdLocal(new Date())
      const candidates = items.filter(a => a.status === 'booked')
      const pickFrom = isToday ? candidates.filter(a => +a.start >= +now) : candidates
      if (pickFrom.length) {
        const n = pickFrom.sort((a,b) => +a.start - +b.start)[0]
        nextAppointment = {
          id: n.id,
          start: n.start,
          end: n.end,
          patient: { id: n.patient.id, firstName: n.patient.firstName, lastName: n.patient.lastName }
        }
      }
  
      // 4) Créneaux libres du jour (pour affichage rapide)
      const freeSlots = await getDailySlots({
        doctorId,
        date: ymdLocal(from),
        durationMinutes
      })
      const freeSlotsMinutes = freeSlots.length * durationMinutes
      const totalPossibleMinutes = minutesBooked + freeSlotsMinutes
      const occupancyRate = totalPossibleMinutes
        ? Number(((minutesBooked / totalPossibleMinutes) * 100).toFixed(1))
        : 0
  
      return c.json({
        doctorId,
        date: ymdLocal(from),
        summary: {
          totalAppointments: total,
          kpis,
          minutesBooked,
          minutesDone,
          avgApptMinutes,
          uniquePatients: patientIds.size,
          noShowRate,
          cancelRate,
          firstAt,
          lastAt,
          revenueEstimatedCFA,
          occupancyRate,      // % d’occupation estimé (booked / (booked + libres))
          nextAppointment
        },
        items,                // liste des RDV du jour (avec patient)
        freeSlots             // slots libres, ex. pour prise rapide
      })
    }
  )
  
