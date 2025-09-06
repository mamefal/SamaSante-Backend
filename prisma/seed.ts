// prisma/seed.ts
import { PrismaClient, Role } from '@prisma/client'
import { createHash } from 'crypto'

const prisma = new PrismaClient()
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

async function main() {
  // Établissement
  const site = await prisma.practiceSite.upsert({
    where: { id: 1 },
    update: {},
    create: {
      name: 'Clinique de Fann',
      type: 'clinique',
      region: 'Dakar',
      city: 'Dakar',
      address: 'Fann, Dakar'
    }
  })

  // Médecin (profil)
  const doctor = await prisma.doctor.upsert({
    where: { id: 1 },
    update: {},
    create: {
      firstName: 'Awa',
      lastName: 'Diop',
      specialty: 'Pédiatrie',
      status: 'verified',
      kycScore: 90,
      ordreNumber: 'SN-12345',
      practiceSiteId: site.id
    }
  })

  // Utilisateur ADMIN
  await prisma.user.upsert({
    where: { email: 'admin@samasante.sn' },
    update: {},
    create: {
      email: 'admin@samasante.sn',
      password: sha256('admin123'),
      role: Role.ADMIN
    }
  })

  // Utilisateur DOCTOR (lié au profil médecin ci-dessus)
  await prisma.user.upsert({
    where: { email: 'awa@samasante.sn' },
    update: {},
    create: {
      email: 'awa@samasante.sn',
      password: sha256('doctor123'),
      role: Role.DOCTOR,
      doctorId: doctor.id
    }
  })

  // Patient démo
  await prisma.patient.upsert({
    where: { id: 1 },
    update: {},
    create: {
      firstName: 'Moussa',
      lastName: 'Ndiaye',
      dob: new Date('1990-01-01'),
      phone: '+221700000000',
      email: 'moussa@example.com',
      medicalFile: { create: {} }
    }
  })

  console.log('✅ Seed terminé : admin + médecin + patient créés.')
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
