addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const clients = new Map()

async function handleRequest(request) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 400 })
  }

  const pair = new WebSocketPair()
  const client = pair[1]
  const id = crypto.randomUUID()
  clients.set(id, client)

  client.accept()

  client.addEventListener('message', msg => {
    // Broadcast message to all other clients
    for (const [otherId, otherClient] of clients.entries()) {
      if (otherId !== id && otherClient.readyState === 1) { // OPEN
        otherClient.send(msg.data)
      }
    }
  })

  client.addEventListener('close', () => {
    clients.delete(id)
  })

  return new Response(null, { status: 101, webSocket: pair[0] })
}