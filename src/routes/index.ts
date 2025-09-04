import { Hono } from 'hono'
import { auth } from './auth'
import { doctors } from './doctors'
import { patients } from './patients'
import { availability } from './availability'
import { appointments } from './appointments'

export const api = new Hono()
api.route('/auth', auth)
api.route('/doctors', doctors)
api.route('/patients', patients)
api.route('/availability', availability)
api.route('/appointments', appointments)
