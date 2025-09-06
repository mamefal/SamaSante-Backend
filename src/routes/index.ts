import { Hono } from 'hono'
import { auth } from './auth.js'
import { doctors } from './doctors.js'
import { patients } from './patients.js'
import { availability } from './availability.js'
import { appointments } from './appointments.js'
import { pub } from './public.js'
import { admin } from './admin.js'

export const api = new Hono()
api.route('/auth', auth)
api.route('/doctors', doctors)
api.route('/patients', patients)
api.route('/availability', availability)
api.route('/appointments', appointments)
api.route('/public', pub)  
api.route('/admin', admin)

