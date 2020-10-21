const Client = require('../')
const common = require('./common')
const fixtures = require('webtorrent-fixtures')
const test = require('tape')

const peerId = Buffer.from('01234567890123456789')
const port = 6881

function testNoEventsAfterDestroy (t, serverType) {
  t.plan(1)

  common.createServer(t, serverType, function (server, announceUrl) {
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.once('update', function () {
      t.fail('no "update" event should fire, since client is destroyed')
    })

    // announce, then immediately destroy
    client.update()
    client.destroy()

    setTimeout(function () {
      t.pass('wait to see if any events are fired')
      server.close()
    }, 1000)
  })
}

test('http: no "update" events after destroy()', function (t) {
  testNoEventsAfterDestroy(t, 'http')
})

test('ws: no "update" events after destroy()', function (t) {
  testNoEventsAfterDestroy(t, 'ws')
})
