import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { createClient } from 'redis'
import pkg from 'pg'

const { Pool } = pkg

const PORT = process.env.PORT || 8080

// Redis + Postgres config from .env (with safe fallbacks)
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1'
const REDIS_PORT = process.env.REDIS_PORT || 6379

const PG_HOST = process.env.PG_HOST || '127.0.0.1'
const PG_PORT = process.env.PG_PORT || 5432
const PG_USER = process.env.PG_USER || 'whiteboard'
const PG_PASSWORD = process.env.PG_PASSWORD || 'whiteboard123'
const PG_DATABASE = process.env.PG_DATABASE || 'whiteboard'

// Unique ID for this node / VM so we can ignore our own Redis messages
const NODE_ID = process.env.NODE_ID || Math.random().toString(36).slice(2)

async function main () {
  const app = express()

  app.use(cors())
  app.use(express.json())

  // In-memory store of latest board snapshots
  // Map<boardId, snapshot>
  const boards = new Map()

  // --- PostgreSQL pool (durable event log) ---
  const pool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE
  })

  console.log('Postgres pool created')

  // --- Redis pub/sub (cross-VM sync bus) ---
  const redisUrl = `redis://${REDIS_HOST}:${REDIS_PORT}`
  const redisPub = createClient({ url: redisUrl })
  const redisSub = createClient({ url: redisUrl })

  await redisPub.connect()
  await redisSub.connect()
  console.log('Connected to Redis at', redisUrl)

  // REST endpoint: get latest board snapshot
  app.get('/board/:id', (req, res) => {
    const id = req.params.id
    const snapshot = boards.get(id) || null
    res.json({ boardId: id, snapshot })
  })

  // REST endpoint: update board via HTTP (not used by tldraw right now,
  // but nice for debugging / future work)
  app.post('/board/:id', (req, res) => {
    const id = req.params.id
    const snapshot = req.body
    boards.set(id, snapshot)
    res.json({ status: 'ok' })
  })

  // Health endpoint for Prometheus / simple check
  app.get('/health', (req, res) => {
    res.send('OK')
  })

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`)
    console.log(`NODE_ID for this instance: ${NODE_ID}`)
  })

  // --- WebSocket Server ---
  const wss = new WebSocketServer({ server })

  function broadcast (msg, except) {
    for (const client of wss.clients) {
      if (client !== except && client.readyState === 1) {
        client.send(msg)
      }
    }
  }

  // When we get a message from Redis, push it to all local WS clients
  redisSub.subscribe('whiteboard-events', (message) => {
    const str = message.toString()
    let msg
    try {
      msg = JSON.parse(str)
    } catch (e) {
      console.error('Bad JSON from Redis:', e)
      return
    }

    // Ignore messages published by this same node to avoid echo/flicker
    if (msg.nodeId && msg.nodeId === NODE_ID) {
      return
    }

    if (msg.type === 'snapshot') {
      const boardId = msg.boardId || 'default'
      boards.set(boardId, msg.snapshot)
    }

    // Fan-out to all clients on THIS VM
    broadcast(str)
  })

  wss.on('connection', (ws) => {
    console.log('Client connected')

    ws.on('message', async (raw) => {
      const str = raw.toString()
      let msg
      try {
        msg = JSON.parse(str)
      } catch (e) {
        console.error('Bad JSON from WS client:', e)
        return
      }

      // Frontend asks for latest state
      if (msg.type === 'request_snapshot') {
        const boardId = msg.boardId || 'default'
        const snapshot = boards.get(boardId)
        if (snapshot) {
          ws.send(
            JSON.stringify({
              type: 'snapshot',
              boardId,
              snapshot
            })
          )
        }
        return
      }

      // Frontend sends a new snapshot of the board
      if (msg.type === 'snapshot') {
        const boardId = msg.boardId || 'default'
        const snapshot = msg.snapshot

        // 1) Update in-memory snapshot
        boards.set(boardId, snapshot)

        // 2) Tag the message with this node's ID
        const extendedMsg = { ...msg, nodeId: NODE_ID }
        const extendedStr = JSON.stringify(extendedMsg)

        // 3) Broadcast to all other WS clients on this VM
        broadcast(extendedStr, ws)

        // 4) Publish to Redis so other app VMs see it
        try {
          await redisPub.publish('whiteboard-events', extendedStr)
        } catch (e) {
          console.error('Failed to publish to Redis:', e)
        }

        // 5) Best-effort log into Postgres as an event
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

      // Anything else is just logged for now
      console.log('Unrecognised WS message:', msg)
    })
  })
}

main().catch((err) => {
  console.error('Fatal error starting server:', err)
  process.exit(1)
})
