const debug = require('debug')('bittorrent-tracker:server')

const http = require('http')
const bencode = require('bencode')

const common = require('../../../lib/common')
const parseHttpRequest = require('./parseHttpRequest')

function attachHttpServer (server) {
  const httpServer = http.createServer()

  const onListening = () => {
    server.listening = true
    debug('listening')
    server.emit('listening')
  }

  const onError = (...args) => { server.onError(...args)}


  httpServer.on('error', onError)
  httpServer.on('listening', onListening)

  const onHttpRequest = (req, res, opts = {}) => {
    if (res.headersSent) return
    opts.trustProxy = opts.trustProxy || server._trustProxy

    let params
    try {
      params = parseHttpRequest(req, opts)
      params.httpReq = req
      params.httpRes = res
    } catch (err) {
      res.end(
        bencode.encode({
          'failure reason': err.message
        })
      )

      // even though it's an error for the client, it's just a warning for the server.
      // don't crash the server because a client sent bad data :)
      server.emit('warning', err)
      return
    }

    server.onRequest(params, (err, response) => {
      if (err) {
        server.emit('warning', err)
        response = {
          'failure reason': err.message
        }
      }
      if (server.destroyed) return res.end()

      delete response.action // only needed for UDP encoding
      res.end(bencode.encode(response))

      if (params.action === common.ACTIONS.ANNOUNCE) {
        server.emit(common.EVENT_NAMES[params.event], params.addr, params)
      }
    })
  }

  server.onHttpRequest = onHttpRequest
  const setRequest = () => httpServer.on('request', (...args) => server.onHttpRequest(...args))

  // Add default http request handler on next tick to give user the chance to add
  // their own handler first. Handle requests untouched by user's handler.
  process.nextTick(setRequest)

  server.http = httpServer
}

module.exports = attachHttpServer
