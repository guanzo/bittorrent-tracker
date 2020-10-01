const attachHttpServer = require('../attachHttp')
const getStats = require('./getStats')
const printClients = require('./printClients')

function setupStatsRoute (server, onListening) {
  if (!server.http) attachHttpServer(server, onListening)

  // Http handler for '/stats' route
  server.http.on('request', (req, res) => {
    if (res.headersSent) return

    if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
      const stats = getStats(server)
      if (req.url === '/stats.json' || req.headers.accept === 'application/json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(stats))
      } else if (req.url === '/stats') {
        const printout = printClients(stats.clients)

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
                    ${printout}
                `.replace(/^\s+/gm, '')) // trim left
      }
    }
  })
}

module.exports = setupStatsRoute
