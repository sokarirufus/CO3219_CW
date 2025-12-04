import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'

const PORT = process.env.PORT || 4000
const app = express()

app.use(cors())
app.use(express.json())

// In-memory store of whiteboard states
const boards = {}  // { boardId: { shapes: [...], lastUpdated: ... } }

// REST endpoint: get board state
app.get('/board/:id', (req, res) => {
  const id = req.params.id
  res.json(boards[id] || { shapes: [] })
})

// REST endpoint: update board state
app.post('/board/:id', (req, res) => {
  const id = req.params.id
  boards[id] = req.body
  boards[id].lastUpdated = Date.now()

  // Notify all connected clients
  broadcast(JSON.stringify({ boardId: id, state: boards[id] }))

  res.json({ status: "ok" })
})

// Health endpoint for Prometheus / simple check
app.get('/health', (req, res) => {
  res.send("OK")
})

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

// --- WebSocket Server ---
const wss = new WebSocketServer({ server })

function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg)
  })
}

wss.on('connection', ws => {
  console.log("Client connected")

  ws.on('message', msg => {
    // If frontend sends shape updates via WS, rebroadcast them
    broadcast(msg.toString())
  })
})
