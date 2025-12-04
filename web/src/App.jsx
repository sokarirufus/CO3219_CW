import { useEffect, useRef, useState } from 'react'
import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'
import './App.css'
import { API_URL, WS_URL } from './config'

function App() {
  const boardId = 'default'
  const wsRef = useRef(null)
  const [backendStatus, setBackendStatus] = useState('Checking...')
  const [wsStatus, setWsStatus] = useState('Connecting...')

  // WebSocket connection
  useEffect(() => {
    console.log('Creating WebSocket with URL:', WS_URL)
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('Connected to WS server')
      setWsStatus('Connected')
    }

    ws.onmessage = (msg) => {
      console.log('Received WS message:', msg.data)
      // later: handle board updates here
    }

    ws.onerror = (err) => {
      console.error('WS error', err)
      setWsStatus('Error')
    }

    ws.onclose = () => {
      console.log('WS connection closed')
      setWsStatus('Closed')
    }

    return () => {
      ws.close()
    }
  }, [])

  // Backend health check
  useEffect(() => {
    console.log('Checking backend health at', `${API_URL}/health`)
    fetch(`${API_URL}/health`)
      .then((res) => res.text())
      .then((text) => {
        console.log('Health response:', text)
        setBackendStatus(`OK (${text})`)
      })
      .catch((err) => {
        console.error('Health check failed', err)
        setBackendStatus('ERROR')
      })
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* Status overlay */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.6)',
          color: 'white',
          fontSize: 12,
          borderRadius: 4,
          zIndex: 10,
        }}
      >
        Board: {boardId} | Backend: {backendStatus} | WS: {wsStatus}
      </div>

      <Tldraw />
    </div>
  )
}

export default App
