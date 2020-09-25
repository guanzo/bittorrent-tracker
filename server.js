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

    if (opts.http !== false) attachHttpServer(this);
    if (opts.ws !== false) attachWSServer(this);
    if (opts.udp !== false) attachUdpServer(this);
    if (opts.stats !== false) setupStatsRoute(this);

    
    const self = this;

  }

  onListening() {
    const numServers = !!this.http + !!this.udp4 + !!this.udp6;
    const numListeners = this.numListeners++

    if (numListeners === numServers) {
      this.listening = true;
      debug("listening");
      self.emit("listening");
    }
  }

  onError(err) {
    this.emit("error", err);
  }

  listen(...args) /* port, hostname, onlistening */ {
    if (this._listenCalled || this.listening)
      throw new Error("server already listening");
    this._listenCalled = true;

    const lastArg = args[args.length - 1];
    if (typeof lastArg === "function") this.once("listening", lastArg);

    const port = toNumber(args[0]) || args[0] || 0;
    const hostname = typeof args[1] !== "function" ? args[1] : undefined;

    debug("listen (port: %o hostname: %o)", port, hostname);

    function isObject(obj) {
      return typeof obj === "object" && obj !== null;
    }

    const httpPort = isObject(port) ? port.http || 0 : port;
    const udpPort = isObject(port) ? port.udp || 0 : port;

    // binding to :: only receives IPv4 connections if the bindv6only sysctl is set 0,
    // which is the default on many operating systems
    const httpHostname = isObject(hostname) ? hostname.http : hostname;
    const udp4Hostname = isObject(hostname) ? hostname.udp : hostname;
    const udp6Hostname = isObject(hostname) ? hostname.udp6 : hostname;

    if (this.http) this.http.listen(httpPort, httpHostname);
    if (this.udp4) this.udp4.bind(udpPort, udp4Hostname);
    if (this.udp6) this.udp6.bind(udpPort, udp6Hostname);
  }

  close(cb) {
    debug("close");

    this.listening = false;
    this.destroyed = true;

    if (this.udp4) {
      try {
        this.udp4.close();
      } catch (err) {
        this.onError(err);
      }
    }

    if (this.udp6) {
      try {
        this.udp6.close();
      } catch (err) {
        this.onError(err);
      }
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        this.onError(err);
      }
    }

    if (this.http) this.http.close(cb);
    else if (cb) cb();
  }

  async createSwarm(infoHash, cb) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString("hex");

    return new Promise(done => {
      const createNewSwarm = () => {
        const swarm = this.torrents[infoHash] = 
                new Server.Swarm(
                      infoHash,
                      this
                    );

        done(swarm);
      };

      process.nextTick(createNewSwarm);
    })
  }

  async getSwarm(infoHash) {
    if (Buffer.isBuffer(infoHash)) infoHash = infoHash.toString("hex");

    return new Promise(done => {
      const returnSwarm = () => {
        done(this.torrents[infoHash]);
      };
    
      process.nextTick(returnSwarm);      
    })
  }

    // Get existing swarm, or create one if one does not exist
  async getOrCreateSwarm(params) {
    try {
      const swarm = this.getSwarm(params.info_hash)
                  || await this.createSwarm(params.info_hash)

    }
    catch(err) { return err }

    return swarm
  }

  async _Request(params) {
    if (params && params.action === common.ACTIONS.CONNECT) {
      return { action: common.ACTIONS.CONNECT }
    } else if (params && params.action === common.ACTIONS.ANNOUNCE) {
      return await this._onAnnounce(params)
    } else if (params && params.action === common.ACTIONS.SCRAPE) {
      return this._onScrape(params)
    } else {
      return new Error("Invalid action")
    }
  }

  fimdIpv4peers(peers) {
    return string2compact(
      peers
        .filter(peer => common.IPV4_RE.test(peer.ip))
        .map(peer => `${peer.ip}:${peer.port}`)
    );
  }

  findIpv6Peers(peers) {
    string2compact(
          peers
            .filter(peer => common.IPV6_RE.test(peer.ip))
            .map(peer => `[${peer.ip}]:${peer.port}`)
        );
  }

  announce(swarm) {
    if (!params.event || params.event === "empty") params.event = "update";

    const onAnnouced = (err, response) => {
      if (err) return cb(err);

      if (!response.action) response.action = common.ACTIONS.ANNOUNCE;
      if (!response.interval)
        response.interval = Math.ceil(this.intervalMs / 1000);

      if (params.compact === 1) {
        const peers = response.peers;

        response.peers = this.findIpv4Peers(peers)
        response.peers6 = this.findIpv6Peers(peers)

      } else if (params.compact === 0) {
        // IPv6 peers are not separate for non-compact responses
        response.peers = response.peers.map((peer) => {
          return {
            "peer id": common.hexToBinary(peer.peerId),
            ip: peer.ip,
            port: peer.port,
          };
        });
      } // else, return full peer objects (used for websocket responses)

      cb(null, response);
    };

    swarm.announce(params, onAnnouced);
  }

  async _onAsyncAnnounce(params) {
    let _params = params;

    if (this._filter) {
      _params = this._filter(params.info_hash, params);
    }

    let swarm;

    try {
      swarm = await getOrCreateSwarm(params);
    } catch (err) {
      return err;
    }

    this.announce(swarm);
  }


  _onScrape(params, cb) {
    if (params.info_hash == null) {
      // if info_hash param is omitted, stats for all torrents are returned
      // TODO: make this configurable!
      params.info_hash = Object.keys(this.torrents);
    }

    series(
      params.info_hash.map((infoHash) => {
        return (cb) => {
          this.getSwarm(infoHash, (err, swarm) => {
            if (err) return cb(err);
            if (swarm) {
              swarm.scrape(params, (err, scrapeInfo) => {
                if (err) return cb(err);
                cb(null, {
                  infoHash,
                  complete: (scrapeInfo && scrapeInfo.complete) || 0,
                  incomplete: (scrapeInfo && scrapeInfo.incomplete) || 0,
                });
              });
            } else {
              cb(null, { infoHash, complete: 0, incomplete: 0 });
            }
          });
        };
      }),
      (err, results) => {
        if (err) return cb(err);

        const response = {
          action: common.ACTIONS.SCRAPE,
          files: {},
          flags: { min_request_interval: Math.ceil(this.intervalMs / 1000) },
        };

        results.forEach((result) => {
          response.files[common.hexToBinary(result.infoHash)] = {
            complete: result.complete || 0,
            incomplete: result.incomplete || 0,
            downloaded: result.complete || 0, // TODO: this only provides a lower-bound
          };
        });

        cb(null, response);
      }
    );
  }
}

Server.Swarm = Swarm

function toNumber (x) {
  x = Number(x)
  return x >= 0 ? x : false
}

function noop () {}

module.exports = Server
