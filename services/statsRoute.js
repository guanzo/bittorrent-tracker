const attachHttpServer = require('./attachHttp')

const get8Chars = 
        peerId => Buffer.from(peerId, "hex")
                        .toString()
                        .substring(0, 8)
              
function addPeerClient( _client, peer) {
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

function addPeerId(allPeers, peerId) {
  // Don't mark the peer as most recently used for stats
  const peer = peers.peek(peerId);

  if (peer == null) return; // peers.peek() can evict the peer

  allPeers[peerId] = {
    ipv6: peer.ip.includes(":"),
    ipv4: !peer.ip.includes(":"),
    seeder: peer.completee,
    leecher: !peer.complete,
    peerId: peer.peerId,
    client: peerid(peer.peerId),
  };

  return allPeers
}

function addTorrentStats(allPeers, torrent) {
    const keys = torrent.peers.keys;

    const result = keys.reduce(addPeerId, allPeers)

    return result
}


const countPeersF =
        peers => 
            filterFunction => 
                Object.values(peers).filter(filterFunction).length

const isActive = torrent => (torrent.peers.keys.length > 0)
const countActive = torrents => torrents.filter(isActive).length
const isSeederOnly = peer => (peer.seeder && peer.leecher === false);
const isLeecherOnly = peer => (peer.leecher && peer.seeder === false);
const isSeederAndLeecher = peer => (peer.seeder && peer.leecher);
const isIPv4 = peer => peer.ipv4;
const isIPv6 = peer => peer.ipv6;

function getStats(server) {
    const torrents = Object.values(server.torrents);
    const allPeers = torrents.reduce(addTorrentStats, {})

    const countAllPeers = countPeersF(allPeers);
    const activeTorrents = countActive(torrents);

    const stats = {
        torrents: torrents.length,
        activeTorrents,
        peersAll: Object.keys(allPeers).length,
        peersSeederOnly: countAllPeers(isSeederOnly),
        peersLeecherOnly: countAllPeers(isLeecherOnly),
        peersSeederAndLeecher: countAllPeers(isSeederAndLeecher),
        peersIPv4: countAllPeers(isIPv4),
        peersIPv6: countAllPeers(isIPv6),
        clients: groupByClient(allPeers),
    };

    return stats;
}

function setupStatsRoute(server) {
  if (!server.http) attachHttpServer(server);

  // Http handler for '/stats' route
  server.http.on("request", (req, res) => {
    if (res.headersSent) return;

    const stats = getStats(server);     

    if (
        req.url === "/stats.json" ||
        req.headers.accept === "application/json"
    ) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(stats));
    } 
    else if (req.url === "/stats") {
        const stats = getStats(server);     

        res.setHeader("Content-Type", "text/html");
        res.end(
            `
            <h1>${stats.torrents} torrents (${stats.activeTorrents} active)</h1>
            <h2>Connected Peers: ${stats.peersAll}</h2>
            <h3>Peers Seeding Only: ${stats.peersSeederOnly}</h3>
            <h3>Peers Leeching Only: ${stats.peersLeecherOnly}</h3>
            <h3>Peers Seeding & Leeching: ${stats.peersSeederAndLeecher}</h3>
            <h3>IPv4 Peers: ${stats.peersIPv4}</h3>
            <h3>IPv6 Peers: ${stats.peersIPv6}</h3>
            <h3>Clients:</h3>
            ${printClients(stats.clients)}
        `.replace(/^\s+/gm, "")
        ); // trim left
    }
  });
}

module.exports = setupStatsRoute