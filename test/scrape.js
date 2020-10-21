const bencode = require('bencode')
const Client = require('../')
const common = require('./common')
const commonLib = require('../lib/common')
const commonTest = require('./common')
const fixtures = require('webtorrent-fixtures')
const get = require('simple-get')
const test = require('tape')

const peerId = Buffer.from('01234567890123456789')

function testSingle (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881,
      wrtc: {}
    })

    if (serverType === 'ws') common.mockWebsocketTracker(client)
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.scrape()

    client.on('scrape', function (data) {
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      client.destroy()
      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: single info_hash scrape', function (t) {
  testSingle(t, 'http')
})

test('ws: single info_hash scrape', function (t) {
  testSingle(t, 'ws')
})

function clientScrapeStatic (t, serverType) {
  commonTest.createServer(t, serverType, function (server, announceUrl) {
    const client = Client.scrape({
      announce: announceUrl,
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      wrtc: {}
    }, function (err, data) {
      t.error(err)
      t.equal(data.announce, announceUrl)
      t.equal(data.infoHash, fixtures.leaves.parsedTorrent.infoHash)
      t.equal(typeof data.complete, 'number')
      t.equal(typeof data.incomplete, 'number')
      t.equal(typeof data.downloaded, 'number')
      server.close(function () {
        t.end()
      })
    })
    if (serverType === 'ws') common.mockWebsocketTracker(client)
  })
}

test('http: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'http')
})

test('ws: scrape using Client.scrape static method', function (t) {
  clientScrapeStatic(t, 'ws')
})

// Ensure the callback function gets called when an invalid url is passed
function clientScrapeStaticInvalid (t, serverType) {
  let announceUrl = serverType + '://invalid.lol'
  if (serverType === 'http') announceUrl += '/announce'

  const client = Client.scrape({
    announce: announceUrl,
    infoHash: fixtures.leaves.parsedTorrent.infoHash,
    wrtc: {}
  }, function (err, data) {
    t.ok(err instanceof Error)
    t.end()
  })
  if (serverType === 'ws') common.mockWebsocketTracker(client)
}

test('http: scrape using Client.scrape static method (invalid url)', function (t) {
  clientScrapeStaticInvalid(t, 'http')
})

test('ws: scrape using Client.scrape static method (invalid url)', function (t) {
  clientScrapeStaticInvalid(t, 'ws')
})

function clientScrapeMulti (t, serverType) {
  const infoHash1 = fixtures.leaves.parsedTorrent.infoHash
  const infoHash2 = fixtures.alice.parsedTorrent.infoHash

  commonTest.createServer(t, serverType, function (server, announceUrl) {
    Client.scrape({
      infoHash: [infoHash1, infoHash2],
      announce: announceUrl
    }, function (err, results) {
      t.error(err)

      t.equal(results[infoHash1].announce, announceUrl)
      t.equal(results[infoHash1].infoHash, infoHash1)
      t.equal(typeof results[infoHash1].complete, 'number')
      t.equal(typeof results[infoHash1].incomplete, 'number')
      t.equal(typeof results[infoHash1].downloaded, 'number')

      t.equal(results[infoHash2].announce, announceUrl)
      t.equal(results[infoHash2].infoHash, infoHash2)
      t.equal(typeof results[infoHash2].complete, 'number')
      t.equal(typeof results[infoHash2].incomplete, 'number')
      t.equal(typeof results[infoHash2].downloaded, 'number')

      server.close(function () {
        t.end()
      })
    })
  })
}

test('http: MULTI scrape using Client.scrape static method', function (t) {
  clientScrapeMulti(t, 'http')
})

test('server: multiple info_hash scrape (manual http request)', function (t) {
  t.plan(13)

  const binaryInfoHash1 = commonLib.hexToBinary(fixtures.leaves.parsedTorrent.infoHash)
  const binaryInfoHash2 = commonLib.hexToBinary(fixtures.alice.parsedTorrent.infoHash)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    const scrapeUrl = announceUrl.replace('/announce', '/scrape')

    const url = scrapeUrl + '?' + commonLib.querystringStringify({
      info_hash: [binaryInfoHash1, binaryInfoHash2]
    })

    get.concat(url, function (err, res, data) {
      t.error(err)

      t.equal(res.statusCode, 200)

      data = bencode.decode(data)
      t.ok(data.files)
      t.equal(Object.keys(data.files).length, 2)

      t.ok(data.files[binaryInfoHash1])
      t.equal(typeof data.files[binaryInfoHash1].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash1].downloaded, 'number')

      t.ok(data.files[binaryInfoHash2])
      t.equal(typeof data.files[binaryInfoHash2].complete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].incomplete, 'number')
      t.equal(typeof data.files[binaryInfoHash2].downloaded, 'number')

      server.close(function () { t.pass('server closed') })
    })
  })
})

test('server: all info_hash scrape (manual http request)', function (t) {
  t.plan(10)

  const binaryInfoHash = commonLib.hexToBinary(fixtures.leaves.parsedTorrent.infoHash)

  commonTest.createServer(t, 'http', function (server, announceUrl) {
    const scrapeUrl = announceUrl.replace('/announce', '/scrape')

    // announce a torrent to the tracker
    const client = new Client({
      infoHash: fixtures.leaves.parsedTorrent.infoHash,
      announce: announceUrl,
      peerId,
      port: 6881
    })
    client.on('error', function (err) { t.error(err) })
    client.on('warning', function (err) { t.error(err) })

    client.start()

    server.once('start', function () {
      // now do a scrape of everything by omitting the info_hash param
      get.concat(scrapeUrl, function (err, res, data) {
        t.error(err)

        t.equal(res.statusCode, 200)
        data = bencode.decode(data)
        t.ok(data.files)
        t.equal(Object.keys(data.files).length, 1)

        t.ok(data.files[binaryInfoHash])
        t.equal(typeof data.files[binaryInfoHash].complete, 'number')
        t.equal(typeof data.files[binaryInfoHash].incomplete, 'number')
        t.equal(typeof data.files[binaryInfoHash].downloaded, 'number')

        client.destroy(function () { t.pass('client destroyed') })
        server.close(function () { t.pass('server closed') })
      })
    })
  })
})
