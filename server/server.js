// Load environment variables
import dotenv from 'dotenv'
dotenv.config()

// Imports
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { createClient } from 'redis'
import pkg from 'pg'
import * as prom from 'prom-client'   // 🔥 UPDATED PROMETHEUS IMPORT

const { Pool } = pkg

// Server port
const PORT = process.env.PORT || 8080

// Redis & Postgres config
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1'
const REDIS_PORT = process.env.REDIS_PORT || 6379

const PG_HOST = process.env.PG_HOST || '127.0.0.1'
const PG_PORT = process.env.PG_PORT || 5432
const PG_USER = process.env.PG_USER || 'whiteboard'
const PG_PASSWORD = process.env.PG_PASSWORD || 'whiteboard123'
const PG_DATABASE = process.env.PG_DATABASE || 'whiteboard'

// Unique instance label for Prometheus (set NODE_ID=app1 or app2 on each VM)
const NODE_ID = process.env.NODE_ID || Math.random().toString(36).slice(2)

async function main () {
  const app = express()

  app.use(cors())
  app.use(express.json())

  // -------------------------------------------
  // 🔥 1) PROMETHEUS REGISTRY & METRICS
  // -------------------------------------------
  const register = new prom.Registry()

  // Label each VM separately so Prometheus can distinguish app-1 vs app-2
  register.setDefaultLabels({
    instance_id: NODE_ID
  })

  // Collect default system metrics (CPU, memory, event loop)
  prom.collectDefaultMetrics({ register })

  // 🔥 HTTP request counter
  const requestCount = new prom.Counter({
    name: 'whiteboard_api_requests_total',
    help: 'Total number of API requests received',
    labelNames: ['route', 'method']
  })
  register.registerMetric(requestCount)

  // 🔥 WebSocket connections gauge
  const connectionGauge = new prom.Gauge({
    name: 'whiteboard_ws_connections',
    help: 'Current number of active WebSocket connections'
  })
  register.registerMetric(connectionGauge)

  // 🔥 Automatically increment HTTP counter for each request
  app.use((req, res, next) => {
    requestCount.inc({ route: req.path, method: req.method })
    next()
  })

  // 🔥 Expose /metrics for Prometheus to scrape
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType)
    res.end(await register.metrics())
  })

  // -------------------------------------------
  // In-memory board snapshots
  // -------------------------------------------
  const boards = new Map()

  // PostgreSQL pool for durable event logging
  const pool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE
  })

  console.log('Postgres pool created')

  // Redis Pub/Sub for cross-VM sync
  const redisUrl = `redis://${REDIS_HOST}:${REDIS_PORT}`
  const redisPub = createClient({ url: redisUrl })
  const redisSub = createClient({ url: redisUrl })

  await redisPub.connect()
  await redisSub.connect()
  console.log('Connected to Redis at', redisUrl)

  // -------------------------------------------
  // REST Endpoints
  // -------------------------------------------

  // Get latest board snapshot
  app.get('/board/:id', (req, res) => {
    const id = req.params.id
    const snapshot = boards.get(id) || null
    res.json({ boardId: id, snapshot })
  })

  // Update board via HTTP (debug)
  app.post('/board/:id', (req, res) => {
    const id = req.params.id
    const snapshot = req.body
    boards.set(id, snapshot)
    res.json({ status: 'ok' })
  })

  // Basic health endpoint
  app.get('/health', (req, res) => {
    res.send('OK')
  })

  // -------------------------------------------
  // Start HTTP Server
  // -------------------------------------------
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`NODE_ID for this instance: ${NODE_ID}`)
  })

  // -------------------------------------------
  // WebSocket Server
  // -------------------------------------------
  const wss = new WebSocketServer({ server })

  function broadcast (msg, except) {
    for (const client of wss.clients) {
      if (client !== except && client.readyState === 1) {
        client.send(msg)
      }
    }
  }

  // Handle Redis → WS fan-out
  redisSub.subscribe('whiteboard-events', (message) => {
    const str = message.toString()
    let msg
    try {
      msg = JSON.parse(str)
    } catch (e) {
      console.error('Bad JSON from Redis:', e)
      return
    }

    // Ignore our own messages
    if (msg.nodeId && msg.nodeId === NODE_ID) {
      return
    }

    // Update snapshot
    if (msg.type === 'snapshot') {
      const boardId = msg.boardId || 'default'
      boards.set(boardId, msg.snapshot)
    }

    // Broadcast to local clients
    broadcast(str)
  })

  // Handle WebSocket connections
  wss.on('connection', (ws) => {
    console.log('Client connected')
    connectionGauge.inc()   // 🔥 Track active WS connections

    ws.on('close', () => {
      connectionGauge.dec() // 🔥 Track disconnects
    })

    ws.on('message', async (raw) => {
      const str = raw.toString()
      let msg
      try {
        msg = JSON.parse(str)
      } catch (e) {
        console.error('Bad JSON from WS client:', e)
        return
      }

      // Send snapshot on request
      if (msg.type === 'request_snapshot') {
        const boardId = msg.boardId || 'default'
        const snapshot = boards.get(boardId)
        if (snapshot) {
          ws.send(JSON.stringify({
            type: 'snapshot',
            boardId,
            snapshot
          }))
        }
        return
      }

      // Handle incoming snapshot updates
      if (msg.type === 'snapshot') {
        const boardId = msg.boardId || 'default'
        const snapshot = msg.snapshot

        boards.set(boardId, snapshot)

        // Tag message with nodeId
        const extendedMsg = { ...msg, nodeId: NODE_ID }
        const extendedStr = JSON.stringify(extendedMsg)

        // Broadcast locally
        broadcast(extendedStr, ws)

        // Publish to Redis for other VMs
        try {
          await redisPub.publish('whiteboard-events', extendedStr)
        } catch (e) {
          console.error('Failed to publish to Redis:', e)
        }

        // Write to Postgres event log
        try {
          await pool.query(
            'INSERT INTO events (board_id, payload) VALUES ($1, $2)',
            [boardId, snapshot]
          )
        } catch (e) {
          console.error('Failed to insert event into Postgres:', e)
        }

        return
      }

      console.log('Unrecognised WS message:', msg)
    })
  })
}

// Start main
main().catch((err) => {
  console.error('Fatal error starting server:', err)
  process.exit(1)
})
