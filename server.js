const debug = require('debug')('bittorrent-tracker:server')
const EventEmitter = require('events')
const series = require('run-series')
const string2compact = require('string2compact')

const attachHttpServer = require('./services/attachHttp')
const attachUdpServer = require('./services/attachUdp')
const attachWSServer = require('./services/attachWS')
const setupStatsRoute = require('./services/statsRoute')
const common = require('./lib/common')
const Swarm = require('./lib/server/swarm')

const SDP_TRICKLE_REGEX = /a=ice-options:trickle\s\n/

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

    if (opts.http !== false) attachHttpServer(this, onListening);
    if (opts.ws !== false) attachWSServer(this, onListening);
    if (opts.udp !== false) attachUdpServer(this, onListening);
    // if (opts.stats !== false) setupStatsRoute(this, onListening);



    if (opts.stats !== false) {
      if (!this.http) {
        attachHttpServer(this, onListening);
        this.http.on('error', err => { this.onError(err) })
        this.http.on('listening', onListening)
      }

      // Http handler for '/stats' route
      this.http.on('request', (req, res) => {
        if (res.headersSent) return

        const infoHashes = Object.keys(this.torrents)
        let activeTorrents = 0
        const allPeers = {}

        function countPeers (filterFunction) {
          let count = 0
          let key

          for (key in allPeers) {
            if (hasOwnProperty.call(allPeers, key) && filterFunction(allPeers[key])) {
              count++
            }
          }

          return count
        }

        function groupByClient () {
          const clients = {}
          for (const key in allPeers) {
            if (hasOwnProperty.call(allPeers, key)) {
              const peer = allPeers[key]

              if (!clients[peer.client.client]) {
                clients[peer.client.client] = {}
              }
              const client = clients[peer.client.client]
              // If the client is not known show 8 chars from peerId as version
              const version = peer.client.version || Buffer.from(peer.peerId, 'hex').toString().substring(0, 8)
              if (!client[version]) {
                client[version] = 0
              }
              client[version]++
            }
          }
          return clients
        }

        function printClients (clients) {
          let html = '<ul>\n'
          for (const name in clients) {
            if (hasOwnProperty.call(clients, name)) {
              const client = clients[name]
              for (const version in client) {
                if (hasOwnProperty.call(client, version)) {
                  html += `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
                }
              }
            }
          }
          html += '</ul>'
          return html
        }

        if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
          infoHashes.forEach(infoHash => {
            const peers = this.torrents[infoHash].peers
            const keys = peers.keys
            if (keys.length > 0) activeTorrents++

            keys.forEach(peerId => {
              // Don't mark the peer as most recently used for stats
              const peer = peers.peek(peerId)
              if (peer == null) return // peers.peek() can evict the peer

              if (!hasOwnProperty.call(allPeers, peerId)) {
                allPeers[peerId] = {
                  ipv4: false,
                  ipv6: false,
                  seeder: false,
                  leecher: false
                }
              }

              if (peer.ip.includes(':')) {
                allPeers[peerId].ipv6 = true
              } else {
                allPeers[peerId].ipv4 = true
              }

              if (peer.complete) {
                allPeers[peerId].seeder = true
              } else {
                allPeers[peerId].leecher = true
              }

              allPeers[peerId].peerId = peer.peerId
              allPeers[peerId].client = peerid(peer.peerId)
            })
          })

          const isSeederOnly = peer => { return peer.seeder && peer.leecher === false }
          const isLeecherOnly = peer => { return peer.leecher && peer.seeder === false }
          const isSeederAndLeecher = peer => { return peer.seeder && peer.leecher }
          const isIPv4 = peer => { return peer.ipv4 }
          const isIPv6 = peer => { return peer.ipv6 }

          const stats = {
            torrents: infoHashes.length,
            activeTorrents,
            peersAll: Object.keys(allPeers).length,
            peersSeederOnly: countPeers(isSeederOnly),
            peersLeecherOnly: countPeers(isLeecherOnly),
            peersSeederAndLeecher: countPeers(isSeederAndLeecher),
            peersIPv4: countPeers(isIPv4),
            peersIPv6: countPeers(isIPv6),
            clients: groupByClient()
          }

          if (req.url === '/stats.json' || req.headers.accept === 'application/json') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(stats))
          } else if (req.url === '/stats') {
            res.setHeader('Content-Type', 'text/html')
            res.end(`
              <h1>${stats.torrents} torrents (${stats.activeTorrents} active)</h1>
              <h2>Connected Peers: ${stats.peersAll}</h2>
              <h3>Peers Seeding Only: ${stats.peersSeederOnly}</h3>
              <h3>Peers Leeching Only: ${stats.peersLeecherOnly}</h3>
              <h3>Peers Seeding & Leeching: ${stats.peersSeederAndLeecher}</h3>
              <h3>IPv4 Peers: ${stats.peersIPv4}</h3>
              <h3>IPv6 Peers: ${stats.peersIPv6}</h3>
              <h3>Clients:</h3>
              ${printClients(stats.clients)}
            `.replace(/^\s+/gm, '')) // trim left
          }
        }
      })
    }

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

    [this.udp4,
    this.udp6,
    this.ws
    ].forEach(closeService)

    if (cb) cb(null);
  }

  createSwarm (infoHash, cb) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    process.nextTick(() => {
      const swarm = this.torrents[infoHash] = new Server.Swarm(infoHash, this)
      cb(null, swarm)
    })
  }

  getSwarm (infoHash, cb) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString('hex')

    process.nextTick(() => {
      cb(null, this.torrents[infoHash])
    })
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
      this._filter(params.info_hash, params, err => {
        // Presence of `err` means that this announce request is disallowed
        if (err) return cb(err)

        getOrCreateSwarm((err, swarm) => {
          if (err) return cb(err)
          announce(swarm)
        })
      })
    } else {
      getOrCreateSwarm((err, swarm) => {
        if (err) return cb(err)
        announce(swarm)
      })
    }

    // Get existing swarm, or create one if one does not exist
    function getOrCreateSwarm (cb) {
      self.getSwarm(params.info_hash, (err, swarm) => {
        if (err) return cb(err)
        if (swarm) return cb(null, swarm)
        self.createSwarm(params.info_hash, (err, swarm) => {
          if (err) return cb(err)
          cb(null, swarm)
        })
      })
    }

    function announce (swarm) {
      if (!params.event || params.event === 'empty') params.event = 'update'
      swarm.announce(params, (err, response) => {
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
      })
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
        this.getSwarm(infoHash, (err, swarm) => {
          if (err) return cb(err)
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
        })
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
