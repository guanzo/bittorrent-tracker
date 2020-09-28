const WebSocketServer = require("ws").Server
const debug = require('debug')('bittorrent-tracker:server')

const common = require('../../../lib/common')

const parseWebSocketRequest = require("./parseWebsocketRequest")
const attachHttpServer = require("../attachHttp")

const SDP_TRICKLE_REGEX = /a=ice-options:trickle\s\n/

function setupHttpService(server, onListening) {
  if (server.http) return server.http
  else {
    attachHttpServer(server, onListening)

    // For websocket trackers, we only need
    // to handle the UPGRADE http method.
    // Return 404 for all other request types
    const notFound = (req, res) => {
      res.statusCode = 404
      res.end("404 Not Found")
    }

    server.http.on("request", notFound)
  }
}

function setupWebSocketServer(server) {
  const { onError } = server
  const options = {
    server: server.http,
    perMessageDeflate: false,
    clientTracking: false,
  }

  const ws = new WebSocketServer(options)

  const onWebSocketConnection = (socket, opts = {}) => {
    opts.trustProxy = opts.trustProxy || server._trustProxy

    socket.peerId = null // as hex
    socket.infoHashes = [] // swarms that server socket is participating in
    socket.onSend = (err) => {
      onWebSocketSend(socket, err)
    }

    socket.onMessageBound = (params) => {
      onWebSocketRequest(socket, opts, params)
    }
    socket.on("message", socket.onMessageBound)

    socket.onErrorBound = (err) => {
      onWebSocketError(socket, err)
    }
    socket.on("error", socket.onErrorBound)

    socket.onCloseBound = () => {
      onWebSocketClose(socket)
    }
    socket.on("close", socket.onCloseBound)
  }

  const onWebSocketRequest = (socket, opts, params) => {
    try {
      params = parseWebSocketRequest(socket, opts, params)
    } catch (err) {
      socket.send(
        JSON.stringify({
          "failure reason": err.message,
        }),
        socket.onSend
      )

      // even though it's an error for the client, it's just a warning for the server.
      // don't crash the server because a client sent bad data :)
      server.emit("warning", err)
      return
    }

    if (!socket.peerId) socket.peerId = params.peer_id // as hex

    server._onRequest(params, (err, response) => {
      if (server.destroyed || socket.destroyed) return
      if (err) {
        socket.send(
          JSON.stringify({
            action:
              params.action === common.ACTIONS.ANNOUNCE ? "announce" : "scrape",
            "failure reason": err.message,
            info_hash: common.hexToBinary(params.info_hash),
          }),
          socket.onSend
        )

        server.emit("warning", err)
        return
      }

      response.action =
        params.action === common.ACTIONS.ANNOUNCE ? "announce" : "scrape"

      let peers
      if (response.action === "announce") {
        peers = response.peers
        delete response.peers

        if (!socket.infoHashes.includes(params.info_hash)) {
          socket.infoHashes.push(params.info_hash)
        }

        response.info_hash = common.hexToBinary(params.info_hash)

        // WebSocket tracker should have a shorter interval – default: 2 minutes
        response.interval = Math.ceil(server.intervalMs / 1000 / 5)
      }

      // Skip sending update back for 'answer' announce messages – not needed
      if (!params.answer) {
        socket.send(JSON.stringify(response), socket.onSend)
        debug(
          "sent response %s to %s",
          JSON.stringify(response),
          params.peer_id
        )
      }

      if (Array.isArray(params.offers)) {
        debug("got %s offers from %s", params.offers.length, params.peer_id)
        debug("got %s peers from swarm %s", peers.length, params.info_hash)

        const gotSwarm = swarm => {
          if (server.destroyed) return
          if (!swarm) {
            return server.emit(
              "warning",
              new Error("no swarm with that `info_hash`")
            )
          }

          peers.forEach((peer, i) => {
            const { sdp } = params.offers && params.offers[i] && params.offers[i].offer || {}
            const isTrickleSdp = SDP_TRICKLE_REGEX.test(sdp)
            if (isTrickleSdp) {
              swarm.offers.set(params.offers[i].offer_id, peer.peerId)
            }

            peer.socket.send(
              JSON.stringify({
                action: "announce",
                offer: params.offers[i].offer,
                offer_id: params.offers[i].offer_id,
                peer_id: common.hexToBinary(params.peer_id),
                info_hash: common.hexToBinary(params.info_hash),
              }),
              peer.socket.onSend
            )
            debug("sent offer to %s from %s", peer.peerId, params.peer_id)
          })
        }

        server.getSwarm(params.info_hash)
          .then()
          .catch(err => server.emit("warning", err))

      }

      const done = () => {
        // emit event once the announce is fully "processed"
        if (params.action === common.ACTIONS.ANNOUNCE) {
          server.emit(common.EVENT_NAMES[params.event], params.peer_id, params)
        }
      }

      if (params.answer) {
        debug(
          "got answer %s from %s",
          JSON.stringify(params.answer),
          params.peer_id
        )

        server.getSwarm(params.info_hash)
              .then(gotSwarm)
              .catch(err => server.emit("warning", err))

        const gotSwarm = swarm => {
          if (server.destroyed) return
          if (!swarm) {
            return server.emit(
              "warning",
              new Error("no swarm with that `info_hash`")
            )
          }
          // Mark the destination peer as recently used in cache
          const toPeer = swarm.peers.get(params.to_peer_id)
          if (!toPeer) {
            return server.emit(
              "warning",
              new Error("no peer with that `to_peer_id`")
            )
          }

          toPeer.socket.send(
            JSON.stringify({
              action: "announce",
              answer: params.answer,
              offer_id: params.offer_id,
              peer_id: common.hexToBinary(params.peer_id),
              info_hash: common.hexToBinary(params.info_hash),
            }),
            toPeer.socket.onSend
          )
          debug("sent answer to %s from %s", toPeer.peerId, params.peer_id)

          done()
        }
      } else {
        done()
      }
    })
  }

  const onWebSocketSend = (socket, err) => {
    if (err) onWebSocketError(socket, err)
  }

  const onWebSocketClose = (socket) => {
    debug("websocket close %s", socket.peerId)
    socket.destroyed = true

    if (socket.peerId) {
      socket.infoHashes.slice(0).forEach((infoHash) => {
        const swarm = server.torrents[infoHash]
        if (swarm) {
          swarm.announce(
            {
              type: "ws",
              event: "stopped",
              numwant: 0,
              peer_id: socket.peerId,
            },
            noop
          )
        }
      })
    }

    // ignore all future errors
    socket.onSend = noop
    socket.on("error", noop)

    socket.peerId = null
    socket.infoHashes = null

    if (typeof socket.onMessageBound === "function") {
      socket.removeListener("message", socket.onMessageBound)
    }
    socket.onMessageBound = null

    if (typeof socket.onErrorBound === "function") {
      socket.removeListener("error", socket.onErrorBound)
    }
    socket.onErrorBound = null

    if (typeof socket.onCloseBound === "function") {
      socket.removeListener("close", socket.onCloseBound)
    }
    socket.onCloseBound = null
  }

  const onWebSocketError = (socket, err) => {
    debug("websocket error %s", err.message || err)
    server.emit("warning", err)
    onWebSocketClose(socket)
  }

  const onConnection = (socket, req) => {
    // Note: socket.upgradeReq was removed in ws@3.0.0, so re-add it.
    // https://github.com/websockets/ws/pull/1099
    socket.upgradeReq = req
    onWebSocketConnection(socket)
  }

  ws.address = () => server.http.address()
  ws.on("connection", onConnection)
  ws.on("error", (err) => onError(err))

  server.ws = ws
}

function createWebSocketServer(server, onListening) {
  setupHttpService(server, onListening)
  setupWebSocketServer(server)
}

module.exports = createWebSocketServer

function noop() { }
