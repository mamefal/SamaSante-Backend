// src/routes/admin.ts
import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { requireAuth } from '../middlewares/auth.js'

export const admin = new Hono()

// ---------- Helpers date (locaux, sans UTC surprise)
function ymdLocal(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
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
function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// ---------- Types utilitaires
type KPIStatus = 'booked' | 'done' | 'cancelled' | 'no_show'
type KPIMap = Record<KPIStatus, number>

// ---------- 1) OVERVIEW (KPIs globaux + agrégats simples)
// GET /api/admin/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&feeCFA=25000
admin.get('/overview', requireAuth(['ADMIN']), async (c) => {
  const fromStr = c.req.query('from') || ymdLocal(new Date())
  const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
  const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined

  const from = startOfDay(fromStr)
  const to = endOfDay(toStr)

  const appts = await prisma.appointment.findMany({
    where: { start: { gte: from }, end: { lte: to } },
    select: {
      id: true, status: true, start: true, end: true,
      patientId: true, doctorId: true
    },
    orderBy: { start: 'asc' }
  })

  const kpis: KPIMap = { booked: 0, done: 0, cancelled: 0, no_show: 0 }
  let minutesBooked = 0
  let minutesDone = 0
  let totalDuration = 0
  const patientIds = new Set<number>()
  const doctorIds = new Set<number>()
  let firstAt: Date | null = null
  let lastAt: Date | null = null

  for (const a of appts) {
    kpis[a.status]++
    const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
    totalDuration += dur
    if (a.status === 'done' || a.status === 'booked') minutesBooked += dur
    if (a.status === 'done') minutesDone += dur
    if (!firstAt) firstAt = a.start
    lastAt = a.end
    patientIds.add(a.patientId)
    doctorIds.add(a.doctorId)
  }

  const total = appts.length
  const noShowRate = total ? Number(((kpis.no_show / total) * 100).toFixed(1)) : 0
  const cancelRate = total ? Number(((kpis.cancelled / total) * 100).toFixed(1)) : 0
  const avgApptMinutes = total ? Math.round(totalDuration / total) : 0
  const revenueEstimatedCFA = feeCFA ? kpis.done * feeCFA : undefined

  return c.json({
    from: ymdLocal(from), to: ymdLocal(to),
    totalAppointments: total,
    kpis,
    minutesBooked, minutesDone, avgApptMinutes,
    uniquePatients: patientIds.size,
    uniqueDoctors: doctorIds.size,
    noShowRate, cancelRate,
    firstAt, lastAt,
    revenueEstimatedCFA
  })
})

// ---------- 2) SÉRIE JOURNALIÈRE (pour graphiques globaux)
// GET /api/admin/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&feeCFA=25000
admin.get('/daily', requireAuth(['ADMIN']), async (c) => {
  const fromStr = c.req.query('from') || ymdLocal(new Date())
  const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
  const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined

  const from = startOfDay(fromStr)
  const to = endOfDay(toStr)

  const appts = await prisma.appointment.findMany({
    where: { start: { gte: from }, end: { lte: to } },
    select: { status: true, start: true, end: true },
    orderBy: { start: 'asc' }
  })

  const days: Record<string, {
    booked: number; done: number; cancelled: number; no_show: number;
    minutesBooked: number; minutesDone: number; revenueEstimatedCFA?: number;
  }> = {}

  // Seed tous les jours
  const cursor = new Date(from)
  while (cursor <= to) {
    const k = ymdLocal(cursor)
    days[k] = { booked: 0, done: 0, cancelled: 0, no_show: 0, minutesBooked: 0, minutesDone: 0, revenueEstimatedCFA: feeCFA ? 0 : undefined }
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const a of appts) {
    const key = ymdLocal(a.start)
    const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
    if (!days[key]) {
      days[key] = { booked: 0, done: 0, cancelled: 0, no_show: 0, minutesBooked: 0, minutesDone: 0, revenueEstimatedCFA: feeCFA ? 0 : undefined }
    }
    days[key][a.status]++
    if (a.status === 'done' || a.status === 'booked') days[key].minutesBooked += dur
    if (a.status === 'done') {
      days[key].minutesDone += dur
      if (feeCFA) days[key].revenueEstimatedCFA! += feeCFA
    }
  }

  const series = Object.entries(days)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }))

  return c.json({ from: ymdLocal(from), to: ymdLocal(to), days: series })
})

// ---------- 3) TOP SPÉCIALITÉS (volumes + revenus estimés)
// GET /api/admin/top-specialties?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=5&feeCFA=25000
admin.get('/top-specialties', requireAuth(['ADMIN']), async (c) => {
  const fromStr = c.req.query('from') || ymdLocal(new Date())
  const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 5
  const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined

  const from = startOfDay(fromStr)
  const to = endOfDay(toStr)

  const appts = await prisma.appointment.findMany({
    where: { start: { gte: from }, end: { lte: to } },
    select: {
      status: true, start: true, end: true,
      doctor: { select: { specialty: true } }
    }
  })

  type Agg = {
    total: number
    done: number
    booked: number
    cancelled: number
    no_show: number
    minutes: number
    revenueEstimatedCFA?: number
  }
  const map = new Map<string, Agg>()

  for (const a of appts) {
    const spec = a.doctor?.specialty || 'Autre'
    if (!map.has(spec)) map.set(spec, { total: 0, done: 0, booked: 0, cancelled: 0, no_show: 0, minutes: 0, revenueEstimatedCFA: feeCFA ? 0 : undefined })
    const agg = map.get(spec)!
    agg.total++
    agg[a.status] = (agg as any)[a.status] + 1
    const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
    agg.minutes += dur
    if (feeCFA && a.status === 'done') agg.revenueEstimatedCFA! += feeCFA
  }

  const rows = Array.from(map.entries())
    .map(([specialty, v]) => ({ specialty, ...v }))
    .sort((a, b) => b.done - a.done || b.total - a.total)
    .slice(0, limit)

  return c.json({
    from: ymdLocal(from), to: ymdLocal(to),
    limit,
    items: rows
  })
})

// ---------- 4) TOP MÉDECINS (leaderboard)
// GET /api/admin/top-doctors?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=5&feeCFA=25000
admin.get('/top-doctors', requireAuth(['ADMIN']), async (c) => {
  const fromStr = c.req.query('from') || ymdLocal(new Date())
  const toStr = c.req.query('to') || ymdLocal(addDays(new Date(fromStr), 6))
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 5
  const feeCFA = c.req.query('feeCFA') ? Number(c.req.query('feeCFA')) : undefined

  const from = startOfDay(fromStr)
  const to = endOfDay(toStr)

  const appts = await prisma.appointment.findMany({
    where: { start: { gte: from }, end: { lte: to } },
    select: {
      status: true, start: true, end: true, doctorId: true,
      doctor: { select: { firstName: true, lastName: true, specialty: true } }
    }
  })

  type DocAgg = {
    doctorId: number
    firstName: string
    lastName: string
    specialty: string | null
    total: number
    done: number
    booked: number
    cancelled: number
    no_show: number
    minutes: number
    revenueEstimatedCFA?: number
  }
  const map = new Map<number, DocAgg>()

  for (const a of appts) {
    const d = a.doctor
    if (!map.has(a.doctorId)) map.set(a.doctorId, {
      doctorId: a.doctorId,
      firstName: d?.firstName || '',
      lastName: d?.lastName || '',
      specialty: d?.specialty || null,
      total: 0, done: 0, booked: 0, cancelled: 0, no_show: 0, minutes: 0,
      revenueEstimatedCFA: feeCFA ? 0 : undefined
    })
    const agg = map.get(a.doctorId)!
    agg.total++
    ;(agg as any)[a.status] = (agg as any)[a.status] + 1
    const dur = Math.max(0, Math.floor((+a.end - +a.start) / 60000))
    agg.minutes += dur
    if (feeCFA && a.status === 'done') agg.revenueEstimatedCFA! += feeCFA
  }

  const items = Array.from(map.values())
    .sort((a, b) => b.done - a.done || b.total - a.total)
    .slice(0, limit)

  return c.json({ from: ymdLocal(from), to: ymdLocal(to), limit, items })
})
