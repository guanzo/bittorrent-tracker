const peerid = require('bittorrent-peerid')

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

const countPeers =
    allPeers =>
        filterFunction => {
            const filteredPeers = 
                    Object.values(allPeers).filter(filterFunction)

            return filteredPeers.length
        }

const addPeer =
    peers =>
        (allPeers, peerId) => {
            // Don't mark the peer as most recently used for stats
            const peer = peers.peek(peerId)

            if (peer == null) return // peers.peek() can evict the peer
 
            const peerData = {
                peerId: peer.peerId,
                client: peerid(peer.peerId),
                ipv4: !peer.ip.includes(':'),
                ipv6: peer.ip.includes(':'),
                seeder: peer.complete,
                leecher: !peer.complete
            }

            allPeers[peerId] = peerData

            return allPeers
        }

const hasKeys = (torrent) => (torrent.peers.keys.length > 0) 
const countActiveTorrents = torrents => torrents.filter(hasKeys).length

const addTorrentKeys = (allPeers, torrent) => {
    const peers = torrent.peers
    const keys = peers.keys

    const result = keys.reduce(addPeer(peers), allPeers)

    return result
}

const isSeederOnly = peer => (peer.seeder && peer.leecher === false)
const isLeecherOnly = peer => (peer.leecher && peer.seeder === false)
const isSeederAndLeecher = peer => (peer.seeder && peer.leecher)
const isIPv4 = peer => peer.ipv4
const isIPv6 = peer => peer.ipv6

const getStats = server => {
    const torrents = Object.values(server.torrents)
    const activeTorrents = countActiveTorrents(torrents)
    const allPeers = torrents.reduce(addTorrentKeys, {})
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

module.exports = getStats