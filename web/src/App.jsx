import { useEffect, useRef, useState } from 'react'
import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'
import './App.css'
import { API_URL, WS_URL } from './config'

function App () {
  const boardId = 'default'

  const wsRef = useRef(null)
  const editorRef = useRef(null)
  const unsubscribeRef = useRef(null)

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

      // Ask backend for latest snapshot for this board
      ws.send(
        JSON.stringify({
          type: 'request_snapshot',
          boardId
        })
      )
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        console.log('Received WS message:', msg)

        if (msg.type === 'snapshot' && msg.boardId === boardId && msg.snapshot) {
          if (editorRef.current) {
            console.log('Applying snapshot from server')
            editorRef.current.store.loadSnapshot(msg.snapshot)
          } else {
            console.warn('Got snapshot but editorRef is null')
          }
        }
      } catch (e) {
        console.error('Failed to parse WS message', e)
      }
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
      console.log('Cleaning up WebSocket')
      ws.close()
    }
  }, [boardId])

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

  // Called when Tldraw editor is ready
  const handleEditorMount = (editor) => {
    console.log('Tldraw editor mounted', editor)
    editorRef.current = editor

    // Listen for document changes and send snapshot to backend
    const unsubscribe = editor.store.listen(
      (event) => {
        console.log('Store changed event:', event)

        const snapshot = editor.store.getSnapshot()
        console.log('Sending snapshot to WS. Snapshot size:', Object.keys(snapshot.document || {}).length)

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'snapshot',
              boardId,
              snapshot
            })
          )
        } else {
          console.warn('WS not open when trying to send snapshot')
        }
      },
      { scope: 'document' }
    )

    unsubscribeRef.current = unsubscribe
  }

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
      }
    }
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
          zIndex: 10
        }}
      >
        Board: {boardId} | Backend: {backendStatus} | WS: {wsStatus}
      </div>

      {/* Whiteboard */}
      <Tldraw onMount={handleEditorMount} />
    </div>
  )
}

export default App
