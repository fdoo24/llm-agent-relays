'use strict';

const http = require('http');
const tls = require('tls');
const path = require('path');
const { loadEnv } = require('../src/env');
const {
  HOP_BY_HOP,
  createLogger,
  makeDechunker,
  buildRoutes,
  routeKey,
  openRoute,
  probeProxyPort,
} = require('../src/common');

function startGroqRelay(customConfig = {}) {
  loadEnv();

  const LISTEN_HOST = customConfig.host || process.env.GROQ_LISTEN_HOST || process.env.RELAY_LISTEN_HOST || '127.0.0.1';
  const LISTEN_PORT = Number(customConfig.port || process.env.GROQ_PORT || 8819);
  const UP_HOST = customConfig.upstreamHost || process.env.GROQ_UPSTREAM_HOST || 'api.groq.com';
  const UP_PORT = Number(customConfig.upstreamPort || process.env.GROQ_UPSTREAM_PORT || 443);
  const UP_PREFIX = (customConfig.upstreamPrefix || process.env.GROQ_UPSTREAM_PREFIX || '/openai/v1').replace(/\/+$/, '');
  const PROXY_HOST = customConfig.proxyHost || process.env.RELAY_PROXY_HOST || '127.0.0.1';

  // Support both 10808 (xray/v2rayN) and 12334 (Hiddify)
  const proxyPortsStr = customConfig.proxyPorts || process.env.GROQ_PROXY_PORTS || process.env.RELAY_PROXY_PORTS || '10808,12334';
  const PROXY_PORTS = proxyPortsStr
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

  const ALLOW_DIRECT = customConfig.allowDirect !== undefined
    ? Boolean(customConfig.allowDirect)
    : (process.env.GROQ_ALLOW_DIRECT === '1' || process.env.RELAY_ALLOW_DIRECT === '1');

  const API_KEY = customConfig.apiKey || process.env.GROQ_API_KEY || '';
  const CONNECT_TIMEOUT_MS = Number(process.env.RELAY_CONNECT_TIMEOUT_MS || 8000);
  const HEADER_TIMEOUT_MS = Number(process.env.RELAY_HEADER_TIMEOUT_MS || 120000);
  const ROUTE_COOLDOWN_MS = Number(process.env.RELAY_COOLDOWN_MS || 60000);

  const logFile = customConfig.logFile || process.env.GROQ_RELAY_LOG || path.join(__dirname, '..', 'logs', 'groq-relay.log');
  const log = createLogger(logFile, 'Groq:8819');

  const ROUTES = buildRoutes(PROXY_PORTS, ALLOW_DIRECT);
  const cooldownUntil = new Map();

  function authHeaders(req) {
    const out = {};
    if (req && req.headers && req.headers['authorization']) {
      out['authorization'] = req.headers['authorization'];
    } else if (API_KEY) {
      out['authorization'] = 'Bearer ' + API_KEY;
    }
    return out;
  }

  function pumpRequest(sock, route, res, method, urlPath, headers, body, started) {
    return new Promise((resolve) => {
      let settled = false;
      let respSent = false;
      let headBuf = Buffer.alloc(0);
      const tlsSock = tls.connect({ socket: sock, servername: UP_HOST });

      const settle = (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      };

      const fail = (msg) => {
        try { tlsSock.destroy(); } catch (_) {}
        if (respSent || res.headersSent || res.writableEnded) settle({ ok: true });
        else settle({ ok: false, err: msg });
      };

      const timer = setTimeout(() => fail('no response headers in ' + HEADER_TIMEOUT_MS + 'ms'), HEADER_TIMEOUT_MS);
      tlsSock.on('error', (e) => fail('tls: ' + e.message));

      tlsSock.once('secureConnect', () => {
        const h = {};
        for (const [k, v] of Object.entries(headers)) {
          const key = k.toLowerCase();
          if (HOP_BY_HOP.has(key)) continue;
          if (v === undefined || v === null) continue;
          h[key] = v;
        }
        h['host'] = UP_HOST;
        h['connection'] = 'close';
        h['content-length'] = String(body.length);

        let head = `${method} ${urlPath} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(h)) {
          head += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`;
        }
        head += '\r\n';
        tlsSock.write(head);
        if (body.length) tlsSock.write(body);
      });

      tlsSock.on('data', function onData(chunk) {
        if (respSent) return;
        headBuf = Buffer.concat([headBuf, chunk]);
        const idx = headBuf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (headBuf.length > 256 * 1024) fail('response headers too large');
          return;
        }
        respSent = true;
        tlsSock.removeListener('data', onData);

        const headText = headBuf.slice(0, idx).toString('latin1');
        const lines = headText.split('\r\n');
        const m = lines[0].match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/);
        const status = m ? Number(m[1]) : 502;
        const statusMsg = m && m[2] ? m[2] : '';

        const out = {};
        const setCookies = [];
        let chunked = false;
        for (let i = 1; i < lines.length; i++) {
          const p = lines[i].indexOf(':');
          if (p <= 0) continue;
          const key = lines[i].slice(0, p).trim().toLowerCase();
          const val = lines[i].slice(p + 1).trim();
          if (key === 'transfer-encoding' && /chunked/i.test(val)) chunked = true;
          if (key === 'set-cookie') { setCookies.push(val); continue; }
          if (HOP_BY_HOP.has(key)) continue;
          out[key] = val;
        }
        if (setCookies.length) out['set-cookie'] = setCookies;

        res.writeHead(status, statusMsg, out);
        const rest = headBuf.slice(idx + 4);
        if (chunked) {
          const decode = makeDechunker((b) => res.write(b));
          tlsSock.on('data', (c) => {
            try { decode(c); } catch (e) {
              log('dechunk failed:', e.message);
              try { res.destroy(); } catch (_) {}
              tlsSock.destroy();
            }
          });
          tlsSock.on('end', () => { try { res.end(); } catch (_) {} });
          if (rest.length) decode(rest);
        } else {
          if (rest.length) res.write(rest);
          tlsSock.pipe(res);
        }
        tlsSock.on('error', () => { try { res.destroy(); } catch (_) {} });
        log(method, urlPath, '->', status, 'via', routeKey(route), `(${Date.now() - started}ms)`);
        settle({ ok: true });
      });

      res.on('close', () => {
        try { tlsSock.destroy(); } catch (_) {}
        settle({ ok: true });
      });
    });
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.setTimeout(0);

    const cleanUrl = (req.url || '').split('?')[0];

    if (cleanUrl === '/health') {
      const ports = PROXY_PORTS.map((p) => probeProxyPort(p, PROXY_HOST));
      Promise.all(ports).then((list) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'groq-relay',
          listen: `http://${LISTEN_HOST}:${LISTEN_PORT}/v1`,
          upstream: `https://${UP_HOST}${UP_PREFIX}`,
          routes: ROUTES.map(routeKey),
          proxies: list,
          hasFallbackKey: Boolean(API_KEY),
        }));
      });
      return;
    }

    if (cleanUrl === '/__diag') {
      (async () => {
        const results = [];
        for (const route of ROUTES) {
          const key = routeKey(route);
          const t0 = Date.now();
          try {
            const sock = await openRoute(route, UP_HOST, UP_PORT, PROXY_HOST, CONNECT_TIMEOUT_MS);
            const status = await new Promise((resolve, reject) => {
              const s = tls.connect({ socket: sock, servername: UP_HOST });
              let buf = Buffer.alloc(0);
              s.setTimeout(20000, () => reject(new Error('no headers in 20s')));
              s.once('error', reject);
              s.once('secureConnect', () => {
                const authH = authHeaders(req);
                let hStr = `GET ${UP_PREFIX}/models HTTP/1.1\r\nHost: ${UP_HOST}\r\nConnection: close\r\nAccept: application/json\r\n`;
                if (authH.authorization) hStr += `Authorization: ${authH.authorization}\r\n`;
                hStr += '\r\n';
                s.write(hStr);
              });
              s.on('data', (c) => {
                buf = Buffer.concat([buf, c]);
                const i = buf.indexOf('\r\n\r\n');
                if (i < 0) return;
                const line = buf.slice(0, i).toString('latin1').split('\r\n')[0];
                const m = line.match(/^HTTP\/1\.[01] (\d{3})/);
                resolve(m ? Number(m[1]) : 0);
                s.destroy();
              });
            });
            results.push({ route: key, status, ms: Date.now() - t0 });
          } catch (e) {
            results.push({ route: key, error: e.message, ms: Date.now() - t0 });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ upstream: UP_HOST + UP_PREFIX, results }, null, 2));
      })();
      return;
    }

    let urlPath = req.url;
    const abs = urlPath.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i);
    if (abs) urlPath = abs[1];

    if (urlPath === '/' || urlPath === '/v1' || urlPath === '/models') {
      urlPath = UP_PREFIX + '/models';
    } else if (urlPath.startsWith('/v1/')) {
      urlPath = UP_PREFIX + urlPath.slice(3);
    }

    if (!urlPath.startsWith(UP_PREFIX)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `Set base URL to http://${LISTEN_HOST}:${LISTEN_PORT}/v1 (got ${req.url})` },
      }));
      return;
    }

    const chunks = [];
    let bodyOk = true;
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {
      bodyOk = false;
      try { res.destroy(); } catch (_) {}
    });

    req.on('end', () => {
      if (!bodyOk) return;
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, ...authHeaders(req) };
      const errors = [];

      const tryRoutes = async (honourCooldown) => {
        for (const route of ROUTES) {
          const key = routeKey(route);
          if (honourCooldown && Date.now() < (cooldownUntil.get(key) || 0)) continue;

          let sock;
          try {
            sock = await openRoute(route, UP_HOST, UP_PORT, PROXY_HOST, CONNECT_TIMEOUT_MS);
          } catch (e) {
            errors.push(`${key}: ${e.message}`);
            cooldownUntil.set(key, Date.now() + ROUTE_COOLDOWN_MS);
            log('route open failed:', key, '-', e.message);
            continue;
          }

          const outcome = await pumpRequest(sock, route, res, req.method, urlPath, headers, body, started);
          if (outcome.ok) return true;
          errors.push(`${key}: ${outcome.err}`);
          cooldownUntil.set(key, Date.now() + ROUTE_COOLDOWN_MS);
          log('route failed:', key, '-', outcome.err);
        }
        return false;
      };

      (async () => {
        const now = Date.now();
        const available = ROUTES.filter((r) => now >= (cooldownUntil.get(routeKey(r)) || 0));
        if (available.length && (await tryRoutes(true))) return;
        if (await tryRoutes(false)) return;

        log('ALL ROUTES FAILED for', req.method, req.url, '|', errors.join('; '));
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        const detail = errors.length ? errors.join('; ') : 'all routes are cooling down after recent failures';
        try {
          res.end(JSON.stringify({ error: { message: 'relay: no working route. ' + detail } }));
        } catch (_) {}
      })();
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 20000;

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log(`Relay active: http://${LISTEN_HOST}:${LISTEN_PORT}/v1 -> https://${UP_HOST}${UP_PREFIX}`);
    log(`Routes: ${ROUTES.map(routeKey).join(' -> ')}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`Port ${LISTEN_PORT} is already in use. Is another relay instance running?`);
      if (customConfig.exitOnError !== false) process.exit(2);
      return;
    }
    log('Server error:', e.message);
    if (customConfig.exitOnError !== false) process.exit(1);
  });

  return server;
}

if (require.main === module) {
  startGroqRelay();
}

module.exports = { startGroqRelay };
