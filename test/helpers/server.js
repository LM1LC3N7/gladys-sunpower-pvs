// -----------------------------------------------------------------------------
// The fake PVS of test/fixtures/pvs.js behind a REAL HTTPS server on
// 127.0.0.1 (the self-signed certificates of ~/code/ref/gladys-testkit,
// copied in test/fixtures/certs so that the CI has them), and a TLS impostor
// that writes a forged answer right after the handshake, before any request.
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTls } from 'node:tls';

const cert = (name) => ({
  key: readFileSync(new URL(`../fixtures/certs/${name}.key`, import.meta.url)),
  cert: readFileSync(new URL(`../fixtures/certs/${name}.crt`, import.meta.url)),
});
export const certs = { device: cert('device'), impostor: cert('impostor') };
export const fingerprintOf = (c) => new X509Certificate(c.cert).fingerprint256;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * An HTTPS server answering as `pvs` (createPvs); `pvs.fingerprint` is set
 * to the real one of the certificate. `srv.mode`: undefined, 'silent',
 * 'redirect', 'big'. `srv.received`: requests that reached it.
 */
export async function pvsServer(pvs, { certificate = certs.device } = {}) {
  pvs.fingerprint = fingerprintOf(certificate);
  const srv = { received: [], mode: undefined };
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    srv.received.push({ path: req.url, headers: req.headers });
    if (srv.mode === 'silent') return;
    if (srv.mode === 'redirect') {
      res.writeHead(302, { location: 'https://example.com/' });
      res.end();
      return;
    }
    if (srv.mode === 'big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(3 * 1024 * 1024, 0x20));
      return;
    }
    pvs
      .request({ path: req.url }, { headers: req.headers, checkPeer: () => {} })
      .then((answer) => {
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body);
      })
      .catch(() => res.destroy());
  });
  server.on('clientError', (err, socket) => socket.destroy());
  srv.port = await listen(server);
  srv.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return srv;
}

/** A TLS server that writes a forged HTTP 200 right after the handshake; `received` bytes after. */
export async function impostorServer() {
  const imp = { received: 0, sockets: new Set() };
  const server = createTls({ key: certs.device.key, cert: certs.device.cert }, (socket) => {
    imp.sockets.add(socket);
    socket.on('data', (chunk) => {
      imp.received += chunk.length;
    });
    socket.on('error', () => {});
    const body = JSON.stringify({ session: 'forged' });
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
    );
  });
  imp.port = await listen(server);
  imp.close = async () => {
    for (const s of imp.sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return imp;
}
