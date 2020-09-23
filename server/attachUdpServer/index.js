const dgram = require('dgram')
const makeUdpPacket = require('./makeUdpPacket')

function attachUdpServer(server) {
  const isNode10 = /^v0.10./.test(process.version)

  const udp4Options = 
          isNode10 
          ? "udp4" 
          : { type: "udp4"
            , reuseAddr: true 
            }

  const udp4 = dgram.createSocket(udp4Options)

  udp4.on("message", (msg, rinfo) => onUdpRequest(msg, rinfo))
  udp4.on("error", (err) => server.onError(err))
  udp4.on("listening", server.onListening)

  const udp6Options = 
          isNode10 
          ? "udp6" 
          : { type: "udp6"
            , reuseAddr: true 
            }

  const udp6 = dgram.createSocket(udp6Options)

  const onUdpRequest = (msg, rinfo) => {
    let params;
    try {
      params = parseUdpRequest(msg, rinfo);
    } catch (err) {
      server.emit("warning", err);
      // Do not reply for parsing errors
      return;
    }

    server._onRequest(params, (err, response) => {
      if (err) {
        server.emit("warning", err);
        response = {
          action: common.ACTIONS.ERROR,
          "failure reason": err.message,
        };
      }
      if (server.destroyed) return;

      response.transactionId = params.transactionId;
      response.connectionId = params.connectionId;

      const buf = makeUdpPacket(response);

      try {
        const udp = rinfo.family === "IPv4" ? server.udp4 : server.udp6;
        udp.send(buf, 0, buf.length, rinfo.port, rinfo.address);
      } catch (err) {
        server.emit("warning", err);
      }

      if (params.action === common.ACTIONS.ANNOUNCE) {
        server.emit(common.EVENT_NAMES[params.event], params.addr, params);
      }
    });
  }

  udp6.on("message", (msg, rinfo) => onUdpRequest(msg, rinfo))
  udp6.on("error", err => server.onError(err))
  udp6.on("listening", server.onListening)

  server.udp4 = server.udp = udp4;
  server.udp6 = udp6;
}

module.exports = attachUdpServer
