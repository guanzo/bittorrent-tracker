const debug = require('debug')('bittorrent-tracker:server')
const EventEmitter = require('events')
const series = require('run-series')
const string2compact = require('string2compact')

const attachHttpService = require('./services/attachHttp')
const attachUdpService = require('./services/attachUdp')
const attachWSService = require('./services/attachWS')
const setupStatsRoute = require('./services/statsRoute')
const common = require('./lib/common')
const Swarm = require('./swarm')

/**
 * BitTorrent tracker server.
 *
 * HTTP service which responds to GET requests from torrent clients. Requests include
 * metrics from clients that help the tracker keep overall statistics about the torrent.
 * Responses include a peer list that helps the client participate in the torrent.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.interval   tell clients to announce on this interval (ms)
 * @param {Number}  opts.trustProxy trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       start an http server? (default: true)
 * @param {boolean} opts.udp        start a udp server? (default: true)
 * @param {boolean} opts.ws         start a websocket server? (default: true)
 * @param {boolean} opts.stats      enable web-based statistics? (default: true)
 * @param {function} opts.filter    black/whitelist fn for disallowing/allowing torrents
 */
const TEN_MINUTES = 10 * 60 * 1000

class Server extends EventEmitter {
  constructor(opts = {}) {
    super();

    this._listenCalled = false;
    this.listening = false;
    this.numListeners = 0
    this.destroyed = false;
    this.torrents = {};

    this.http = null;
    this.udp4 = null;
    this.udp6 = null;
    this.ws = null;

    debug("new server %s", JSON.stringify(opts));

    const {
      interval,
      trustProxy,
      filter,
      peersCacheLength,
      peersCacheTtl,
    } = opts;

    this.intervalMs = interval || TEN_MINUTES;
    this._trustProxy = Boolean(trustProxy);
    this._filter = filter;
    this.peersCacheLength = peersCacheLength;
    this.peersCacheTtl = peersCacheTtl;

    if (opts.http !== false) attachHttpService(this, onListening);
    if (opts.ws !== false) attachWSService(this, onListening);
    if (opts.udp !== false) attachUdpService(this, onListening);
    if (opts.stats !== false) setupStatsRoute(this, onListening);

    let num = !!this.http + !!this.udp4 + !!this.udp6
    this.num = num

    const self = this
    function onListening () {
      num -= 1
      if (num === 0) {
        self.listening = true
        debug('listening')
        self.emit('listening')
      }
    }
  }

  onListening() {
    this.num -= 1

    if (this.num === 0) {
      this.listening = true
      debug('listening')
      this.emit('listening')
    }
  }

  onError (err) {
    this.emit('error', err)
  }

  listen (...args) /* port, hostname, onlistening */{
    if (this._listenCalled || this.listening) throw new Error('server already listening')
    this._listenCalled = true

    const lastArg = args[args.length - 1]
    if (typeof lastArg === 'function') this.once('listening', lastArg)

    const port = toNumber(args[0]) || args[0] || 0
    const hostname = typeof args[1] !== 'function' ? args[1] : undefined

    debug('listen (port: %o hostname: %o)', port, hostname)

    function isObject (obj) {
      return typeof obj === 'object' && obj !== null
    }

    const httpPort = isObject(port) ? (port.http || 0) : port
    const udpPort = isObject(port) ? (port.udp || 0) : port

    // binding to :: only receives IPv4 connections if the bindv6only sysctl is set 0,
    // which is the default on many operating systems
    const httpHostname = isObject(hostname) ? hostname.http : hostname
    const udp4Hostname = isObject(hostname) ? hostname.udp : hostname
    const udp6Hostname = isObject(hostname) ? hostname.udp6 : hostname

    if (this.http) this.http.listen(httpPort, httpHostname)
    if (this.udp4) this.udp4.bind(udpPort, udp4Hostname)
    if (this.udp6) this.udp6.bind(udpPort, udp6Hostname)
  }

  close(cb) {
    debug("close");

    this.listening = false;
    this.destroyed = true;

    const closeService = service => {
      if (service) {
        try {
          service.close();
        } catch (err) {
          this.onError(err);
        }
      }
    }

    [ this.udp4,
      this.udp6,
      this.ws
    ].forEach(closeService)

    if (cb) cb(null);
  }

  async createSwarm(infoHash) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    const createdSwarm = resolve => {
      process.nextTick(() => {
        const swarm = this.torrents[infoHash] = new Server.Swarm(infoHash, this)
        resolve(swarm)
      })
    }

    return new Promise(createdSwarm)
  }

  async getSwarm(infoHash) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    const gotSwarm = resolve => {
      process.nextTick(() => {
        resolve(this.torrents[infoHash])
      })
    }

    return new Promise(gotSwarm)
  }

  // Get existing swarm, or create one if one does not exist  
  async getOrCreateSwarm(params) {
    const swarm = await this.getSwarm(params.info_hash)
                || await this.createSwarm(params.info_hash)

    return swarm
  }

  _onRequest (params, cb) {
    if (params && params.action === common.ACTIONS.CONNECT) {
      cb(null, { action: common.ACTIONS.CONNECT })
    } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
      this._onAnnounce(params, cb)
    } else if (params && params.action === common.ACTIONS.SCRAPE) {
      this._onScrape(params, cb)
    } else {
      cb(new Error('Invalid action'))
    }
  }

  _onAnnounce (params, cb) {
    const self = this

    if (this._filter) {
      const onFiltered = err => {
        // Presence of `err` means that this announce request is disallowed
        if (err) return cb(err)

        this.getOrCreateSwarm(params)
          .then(announce)
      }

      this._filter(params.info_hash, params, onFiltered)
    } else {
      this.getOrCreateSwarm(params)
        .then(announce)
    }

    function announce (swarm) {
      if (!params.event || params.event === 'empty') params.event = 'update'

      const _onAnnounce = (err, response) => {
        if (err) return cb(err)

        if (!response.action) response.action = common.ACTIONS.ANNOUNCE
        if (!response.interval) response.interval = Math.ceil(self.intervalMs / 1000)

        if (params.compact === 1) {
          const peers = response.peers

          // Find IPv4 peers
          response.peers = string2compact(peers.filter(peer => {
            return common.IPV4_RE.test(peer.ip)
          }).map(peer => {
            return `${peer.ip}:${peer.port}`
          }))
          // Find IPv6 peers
          response.peers6 = string2compact(peers.filter(peer => {
            return common.IPV6_RE.test(peer.ip)
          }).map(peer => {
            return `[${peer.ip}]:${peer.port}`
          }))
        } else if (params.compact === 0) {
          // IPv6 peers are not separate for non-compact responses
          response.peers = response.peers.map(peer => {
            return {
              'peer id': common.hexToBinary(peer.peerId),
              ip: peer.ip,
              port: peer.port
            }
          })
        } // else, return full peer objects (used for websocket responses)

        cb(null, response)
      }

      swarm.announce(params, _onAnnounce )
    }
  }

  _onScrape (params, cb) {
    if (params.info_hash == null) {
      // if info_hash param is omitted, stats for all torrents are returned
      // TODO: make this configurable!
      params.info_hash = Object.keys(this.torrents)
    }

    series(params.info_hash.map(infoHash => {
      return cb => {
        const gotSwarm = swarm => {
          if (swarm) {
            swarm.scrape(params, (err, scrapeInfo) => {
              if (err) return cb(err)
              cb(null, {
                infoHash,
                complete: (scrapeInfo && scrapeInfo.complete) || 0,
                incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0
              })
            })
          } else {
            cb(null, { infoHash, complete: 0, incomplete: 0 })
          }
        }

        this.getSwarm(infoHash)
          .then(gotSwarm)
          .catch(cb)
      }
    }), (err, results) => {
      if (err) return cb(err)

      const response = {
        action: common.ACTIONS.SCRAPE,
        files: {},
        flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) }
      }

      results.forEach(result => {
        response.files[common.hexToBinary(result.infoHash)] = {
          complete: result.complete || 0,
          incomplete: result.incomplete || 0,
          downloaded: result.complete || 0 // TODO: this only provides a lower-bound
        }
      })

      cb(null, response)
    })
  }
}

Server.Swarm = Swarm

function toNumber (x) {
  x = Number(x)
  return x >= 0 ? x : false
}

function noop () {}

module.exports = Server
