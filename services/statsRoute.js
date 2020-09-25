const peerid = require('bittorrent-peerid')

const attachHttpServer = require('./attachHttp')

const get8Chars = 
        peerId => Buffer.from(peerId, "hex")
                        .toString()
                        .substring(0, 8)
              
function addPeerClient( _clients, peer) {
    const clientId = peer.client.client;
    const client = _clients[clientId] || {};
    // If the client is not known show 8 chars from peerId as version
    const version = peer.client.version 
                    || get8Chars(peer.peerId)

    if (!client[version]) client[version] = 1
    else client[version]++

    _clients[clientId] = client

    return _clients                        
}

function groupByClient(allPeers) {
    const clients = 
            Object.values(allPeers)
                  .reduce(addPeerClient, {})
          
    return clients;
}

const printVersionHtml = client => (html, version) => (
    html + `<li><strong>${name}</strong> ${version} : ${client[version]}</li>\n`
)

function printClient(html, client) {
    const printClientHtml = printVersionHtml(client);
    const clientHtml = 
            Object.values(client).reduce(printClientHtml, html)

    return clientHtml;
};

function printClients(clients) {
  let initialHtml = "<ul>\n";

  const html = Object.values(clients).reduce(printClient, initialHtml)

  return html + "</ul>";
}

const countPeers =
    allPeers =>
        filterFunction => {
            let count = 0
            let key

            for (key in allPeers) {
                if (hasOwnProperty.call(allPeers, key) && filterFunction(allPeers[key])) {
                    count++
                } 0
            }

            return count
        }

const addPeer =
    peers =>
        (allPeers, peerId) => {
            // Don't mark the peer as most recently used for stats
            const peer = peers.peek(peerId)

            if (peer == null) return // peers.peek() can evict the peer

            allPeers[peerId] = {
                ipv4: false,
                ipv6: false,
                seeder: false,
                leecher: false
            }

            if (peer.ip.includes(':')) allPeers[peerId].ipv6 = true
            if (!peer.ip.includes(':')) allPeers[peerId].ipv4 = true

            if (peer.complete) allPeers[peerId].seeder = true
            if (!peer.complete) allPeers[peerId].leecher = true

            allPeers[peerId].peerId = peer.peerId
            allPeers[peerId].client = peerid(peer.peerId)

            return allPeers
        }

const countActiveTorrents = torrents => {
    const hasKeys = (torrent) => (torrent.peers.keys.length > 0) 

    const activeTorrents = torrents.filter(hasKeys, 0)
    return activeTorrents.length
}

const addTorrentKeys = (allPeers, torrent) => {
    const peers = torrent.peers
    const keys = peers.keys

    const result = keys.reduce(addPeer(peers), allPeers)

    return result
}

const getTheStats = server => {
    const torrents = Object.values(server.torrents)
    const allPeers = torrents.reduce(addTorrentKeys, {})

    const activeTorrents = countActiveTorrents(Object.values(server.torrents))
    const isSeederOnly = peer => (peer.seeder && peer.leecher === false)
    const isLeecherOnly = peer => (peer.leecher && peer.seeder === false)
    const isSeederAndLeecher = peer => (peer.seeder && peer.leecher)
    const isIPv4 = peer => peer.ipv4
    const isIPv6 = peer => peer.ipv6
    const countAllPeers = countPeers(allPeers)

    const stats = {
        torrents: torrents.length,
        activeTorrents,
        peersAll: Object.keys(allPeers).length,
        peersSeederOnly: countAllPeers(isSeederOnly),
        peersLeecherOnly: countAllPeers(isLeecherOnly),
        peersSeederAndLeecher: countAllPeers(isSeederAndLeecher),
        peersIPv4: countAllPeers(isIPv4),
        peersIPv6: countAllPeers(isIPv6),
        clients: groupByClient(allPeers)
    }

    return stats
}

function setupStatsRoute(server, onListening) {
  if (!server.http) attachHttpServer(server, onListening);
   // Http handler for '/stats' route
    server.http.on('request', (req, res) => {
    if (res.headersSent) return

    if (req.method === 'GET' && (req.url === '/stats' || req.url === '/stats.json')) {
        const stats = getTheStats(server)

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

module.exports = setupStatsRoute