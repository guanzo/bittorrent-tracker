const common = require('../lib/common')

function makeUdpPacket (params) {
  let packet
  
  switch (params.action) {
    case common.ACTIONS.CONNECT: {
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.CONNECT),
        common.toUInt32(params.transactionId),
        params.connectionId
      ])
      break
    }
    case common.ACTIONS.ANNOUNCE: {
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ANNOUNCE),
        common.toUInt32(params.transactionId),
        common.toUInt32(params.interval),
        common.toUInt32(params.incomplete),
        common.toUInt32(params.complete),
        params.peers
      ])
      break
    }
    case common.ACTIONS.SCRAPE: {
      const scrapeResponse = [
        common.toUInt32(common.ACTIONS.SCRAPE),
        common.toUInt32(params.transactionId)
      ]
      for (const infoHash in params.files) {
        const file = params.files[infoHash]
        scrapeResponse.push(
          common.toUInt32(file.complete),
          common.toUInt32(file.downloaded), // TODO: this only provides a lower-bound
          common.toUInt32(file.incomplete)
        )
      }
      packet = Buffer.concat(scrapeResponse)
      break
    }
    case common.ACTIONS.ERROR: {
      packet = Buffer.concat([
        common.toUInt32(common.ACTIONS.ERROR),
        common.toUInt32(params.transactionId || 0),
        Buffer.from(String(params['failure reason']))
      ])
      break
    }
    default:
      throw new Error(`Action not implemented: ${params.action}`)
  }
  return packet
}

module.exports = makeUdpPacket;
