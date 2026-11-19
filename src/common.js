'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function createLogger(logFilePath, prefix = '') {
  return function log(...args) {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${prefix ? `[${prefix}] ` : ''}${args.join(' ')}`;
    console.log(line);
    if (!logFilePath) return;
    try {
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 5 * 1024 * 1024) {
        fs.truncateSync(logFilePath, 0);
      }
      fs.appendFileSync(logFilePath, line + '\n');
    } catch (_) {
      // logging must never throw or break proxying
    }
  };
}

function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    const fail = (err) => {
      sock.destroy();
      reject(err);
    };

    sock.setTimeout(timeoutMs, () => fail(new Error(`SOCKS5 timeout on ${stage}`)));
    sock.on('error', fail);

    sock.once('connect', () => {
      // Send greeting (no auth)
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    sock.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          return fail(new Error(`SOCKS5 greeting rejected (${buf.slice(0, 8).toString('hex')})`));
        }
        stage = 'request';
        buf = Buffer.alloc(0);
        const hostBuf = Buffer.from(targetHost);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]));
      } else if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : 0;
        if (!addrLen) return fail(new Error(`SOCKS5 bad ATYP ${atyp}`));
        if (buf.length < 6 + addrLen) return;
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS5 CONNECT failed, code 0x${buf[1].toString(16)}`));

        sock.removeListener('data', onData);
        sock.setTimeout(0);
        resolve(sock);
      }
    });
  });
}

function httpConnect(proxyHost, proxyPort, targetHost, targetPort, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let head = '';
    const fail = (err) => {
      sock.destroy();
      reject(err);
    };

    sock.setTimeout(timeoutMs, () => fail(new Error('HTTP CONNECT timeout')));
    sock.on('error', fail);

    sock.on('data', function onData(chunk) {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      const statusLine = head.split('\r\n')[0];
      if (!/HTTP\/1\.[01] 200/.test(statusLine)) {
        return fail(new Error(`HTTP CONNECT rejected: ${statusLine}`));
      }
      sock.setTimeout(0);
      resolve(sock);
    });

    sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
  });
}

function directConnect(targetHost, targetPort, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(targetPort, targetHost);
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('Direct connect timeout'));
    });
    sock.once('error', (e) => reject(e));
    sock.once('connect', () => {
      sock.setTimeout(0);
      resolve(sock);
    });
  });
}

function makeDechunker(onData) {
  let buf = Buffer.alloc(0);
  let state = 'size';
  let remaining = 0;

  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === 'size') {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) return;
        const line = buf.slice(0, idx).toString('latin1').split(';')[0].trim();
        buf = buf.slice(idx + 2);
        const size = parseInt(line, 16);
        if (!Number.isFinite(size) || size < 0) throw new Error(`Bad chunk size: ${line}`);
        if (size === 0) {
          state = 'done';
          return;
        }
        remaining = size;
        state = 'data';
      } else if (state === 'data') {
        if (buf.length === 0) return;
        const take = Math.min(remaining, buf.length);
        onData(buf.slice(0, take));
        buf = buf.slice(take);
        remaining -= take;
        if (remaining > 0) return;
        state = 'crlf';
      } else if (state === 'crlf') {
        if (buf.length < 2) return;
        buf = buf.slice(2);
        state = 'size';
      } else {
        buf = Buffer.alloc(0);
        return;
      }
    }
  };
}

function buildRoutes(proxyPorts, allowDirect = false) {
  const routes = [];
  for (const port of proxyPorts) routes.push({ kind: 'socks5', port });
  for (const port of proxyPorts) routes.push({ kind: 'http', port });
  if (allowDirect) routes.push({ kind: 'direct' });
  return routes;
}

function routeKey(route) {
  return route.kind + (route.port ? '@' + route.port : '');
}

function openRoute(route, targetHost, targetPort, proxyHost = '127.0.0.1', timeoutMs = 8000) {
  if (route.kind === 'socks5') return socks5Connect(proxyHost, route.port, targetHost, targetPort, timeoutMs);
  if (route.kind === 'http') return httpConnect(proxyHost, route.port, targetHost, targetPort, timeoutMs);
  return directConnect(targetHost, targetPort, timeoutMs);
}

function probeProxyPort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const finish = (reachable) => {
      try { s.destroy(); } catch (_) {}
      resolve({ port, reachable });
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

module.exports = {
  HOP_BY_HOP,
  createLogger,
  socks5Connect,
  httpConnect,
  directConnect,
  makeDechunker,
  buildRoutes,
  routeKey,
  openRoute,
  probeProxyPort,
};
