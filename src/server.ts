import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { api } from './routes/index.js'
import { serve } from '@hono/node-server'


const app = new Hono()
app.use('*', cors())
app.get('/', (c) => c.text('SamaSanté API OK'))
app.route('/api', api)
app.notFound((c) => c.text('Not Found', 404))
app.onError((err, c) => {
  console.error(err)
  return c.text('Internal Server Error', 500)
})

const port = Number(process.env.PORT || 3000)
serve({ fetch: app.fetch, port })
console.log(`API running on http://localhost:${port}`)
