// src/lib/slots.ts
import { prisma } from './prisma.js'

type Rule = {
  freq: 'WEEKLY'
  byweekday: number[] // 0..6 (dim..sam) OU 1..7 (lun..dim)
  start: string       // "HH:MM"
  end: string         // "HH:MM"
}

function mapWeekdayTo0Sun6Sat(n: number) {
  // Si 0..6 on garde; si 1..7 (lun..dim) -> map 1..6,0
  if (n >= 0 && n <= 6) return n
  if (n >= 1 && n <= 7) return n % 7 // 7 -> 0 (dimanche)
  throw new Error('byweekday invalide')
}

function toLocalDateAt(day: Date, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(day)
  d.setHours(h, m || 0, 0, 0)
  return d
}

function* splitIntoSlots(start: Date, end: Date, durationMin: number) {
  const ms = durationMin * 60 * 1000
  for (let t = +start; t + ms <= +end; t += ms) {
    yield { start: new Date(t), end: new Date(t + ms) }
  }
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart
}

/**
 * Retourne les créneaux ouverts pour un médecin et un jour donné,
 * en retirant ceux déjà pris par des RDV "booked".
 */
export async function getDailySlots(opts: {
  doctorId: number
  date: string // "YYYY-MM-DD"
  durationMinutes?: number // défaut 20
  siteId?: number
}) {
  const { doctorId, date, durationMinutes = 20, siteId } = opts
  const day = new Date(date + 'T00:00:00') // TZ du process (ex: Africa/Dakar)
  const weekday = day.getDay() // 0=dim ... 6=sam

  // Récupérer les règles de dispo
  const avails = await prisma.availability.findMany({
    where: { doctorId, ...(siteId ? { siteId } : {}) }
  })

  // Fenêtre du jour
  const dayStart = new Date(day)
  const dayEnd = new Date(day)
  dayEnd.setHours(23, 59, 59, 999)

  // RDV existants ce jour
  const appts = await prisma.appointment.findMany({
    where: {
      doctorId,
      status: 'booked',
      start: { lt: dayEnd },
      end: { gt: dayStart }
    },
    orderBy: { start: 'asc' }
  })

  const slots: { start: Date; end: Date }[] = []
  const seen = new Set<string>() // déduplication (si dispos dupliquées)

  for (const a of avails) {
    let rule: Rule
    try {
      rule = JSON.parse(a.ruleJson)
    } catch {
      continue
    }
    if (rule.freq !== 'WEEKLY') continue

    const mappedWeekdays = rule.byweekday.map(mapWeekdayTo0Sun6Sat)
    if (!mappedWeekdays.includes(weekday)) continue

    const blockStart = toLocalDateAt(day, rule.start)
    const blockEnd = toLocalDateAt(day, rule.end)
    if (+blockEnd <= +blockStart) continue

    for (const s of splitIntoSlots(blockStart, blockEnd, durationMinutes)) {
      const conflict = appts.some((r) => overlaps(s.start, s.end, r.start, r.end))
      if (conflict) continue

      const key = `${s.start.toISOString()}|${s.end.toISOString()}`
      if (!seen.has(key)) {
        seen.add(key)
        slots.push(s)
      }
    }
  }

  return slots.map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    durationMinutes
  }))
}

/** Vérifie qu'un start/end correspond à un slot libre généré (simple check) */
export async function isBookable(opts: {
  doctorId: number
  startISO: string
  endISO: string
  durationMinutes?: number
  siteId?: number
}) {
  const { doctorId, startISO, endISO, durationMinutes = 20, siteId } = opts
  const start = new Date(startISO)
  const end = new Date(endISO)
  const ymd = start.toISOString().slice(0, 10)
  const slots = await getDailySlots({ doctorId, date: ymd, durationMinutes, siteId })
  return slots.some((s) => s.start === start.toISOString() && s.end === end.toISOString())
}
