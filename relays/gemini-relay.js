'use strict';

const http = require('http');
const tls = require('tls');
const fs = require('fs');
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

const DROP_FIELDS = ['store', 'thinking', 'verbosity'];
const HIDE_MODEL_RE = /(tts|embedding|aqa|lyria|native-audio|transcribe|-image|banana|robotics|deep-research|computer-use|decision-1)/i;

function startGeminiRelay(customConfig = {}) {
  loadEnv();

  const LISTEN_HOST = customConfig.host || process.env.GEMINI_LISTEN_HOST || process.env.RELAY_LISTEN_HOST || '127.0.0.1';
  const LISTEN_PORT = Number(customConfig.port || process.env.GEMINI_PORT || process.env.GEMINI_RELAY_PORT || 8820);
  const UP_HOST = customConfig.upstreamHost || process.env.GEMINI_UPSTREAM_HOST || 'generativelanguage.googleapis.com';
  const UP_PORT = Number(customConfig.upstreamPort || process.env.GEMINI_UPSTREAM_PORT || 443);
  const UP_PREFIX = (customConfig.upstreamPrefix || process.env.GEMINI_UPSTREAM_PREFIX || '/v1beta/openai').replace(/\/+$/, '');
  const PROXY_HOST = customConfig.proxyHost || process.env.RELAY_PROXY_HOST || '127.0.0.1';

  const proxyPortsStr = customConfig.proxyPorts || process.env.GEMINI_PROXY_PORTS || process.env.RELAY_PROXY_PORTS || '10808,12334';
  const PROXY_PORTS = proxyPortsStr
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

  const ALLOW_DIRECT = customConfig.allowDirect !== undefined
    ? Boolean(customConfig.allowDirect)
    : (process.env.GEMINI_ALLOW_DIRECT === '1' || process.env.RELAY_ALLOW_DIRECT === '1');

  const API_KEY = customConfig.apiKey || process.env.GEMINI_API_KEY || '';
  const CONNECT_TIMEOUT_MS = Number(process.env.RELAY_CONNECT_TIMEOUT_MS || 8000);
  const TLS_HANDSHAKE_TIMEOUT_MS = Number(process.env.RELAY_TLS_TIMEOUT_MS || 12000);
  const HEADER_TIMEOUT_MS = Number(process.env.RELAY_HEADER_TIMEOUT_MS || 180000);
  const ROUTE_COOLDOWN_MS = Number(process.env.RELAY_COOLDOWN_MS || 60000);

  const logFile = customConfig.logFile || process.env.GEMINI_RELAY_LOG || path.join(__dirname, '..', 'logs', 'gemini-relay.log');
  const log = createLogger(logFile, 'Gemini:8820');

  const SIG_PATH = customConfig.sigPath || process.env.GEMINI_SIG_STORE || path.join(__dirname, '..', 'data', 'gemini-signatures.json');
  const sigById = new Map();
  const sigByName = new Map();
  let sigLast = null;
  let sigDirty = false;

  function loadSignatures() {
    try {
      if (fs.existsSync(SIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(SIG_PATH, 'utf8'));
        for (const [id, sig] of raw.byId || []) sigById.set(id, sig);
        for (const [name, sig] of raw.byName || []) sigByName.set(name, sig);
        if (typeof raw.last === 'string') sigLast = raw.last;
        log(`Signatures loaded: ${sigById.size} by id, ${sigByName.size} by name`);
      }
    } catch (_) {}
  }

  function saveSignatures() {
    if (!sigDirty) return;
    sigDirty = false;
    try {
      const dir = path.dirname(SIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ids = [...sigById.entries()].slice(-300);
      fs.writeFileSync(SIG_PATH, JSON.stringify({
        byId: ids,
        byName: [...sigByName.entries()].slice(-50),
        last: sigLast,
      }));
    } catch (e) {
      log('Signature store save error:', e.message);
    }
  }

  loadSignatures();
  const sigTimer = setInterval(saveSignatures, 2000);
  sigTimer.unref();

  function rememberSignature(id, name, sig) {
    if (!sig || typeof sig !== 'string') return;
    if (id) sigById.set(id, sig);
    if (name) sigByName.set(name, sig);
    sigLast = sig;
    sigDirty = true;
  }

  function harvestJson(obj) {
    const choices = (obj && obj.choices) || [];
    for (const ch of choices) {
      const parts = (ch.delta && ch.delta.tool_calls) || (ch.message && ch.message.tool_calls) || [];
      for (const tc of parts) {
        const sig = tc && tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature;
        if (sig) rememberSignature(tc.id, tc.function && tc.function.name, sig);
      }
    }
  }

  function makeHarvester() {
    let buf = '';
    return function feed(chunk) {
      buf += chunk.toString('utf8');
      if (buf.length > 2 * 1024 * 1024) buf = buf.slice(-65536);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        if (!payload.includes('thought_signature')) continue;
        try { harvestJson(JSON.parse(payload)); } catch (_) {}
      }
    };
  }

  function injectSignatures(body) {
    const notes = [];
    for (const msg of body.messages || []) {
      if (!msg || !Array.isArray(msg.tool_calls)) continue;
      for (const tc of msg.tool_calls) {
        if (!tc) continue;
        const have = tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature;
        if (have) continue;
        const name = tc.function && tc.function.name;
        const sig = (tc.id && sigById.get(tc.id)) || (name && sigByName.get(name)) || sigLast;
        if (!sig) continue;
        tc.extra_content = { google: { thought_signature: sig } };
        notes.push('+sig' + (tc.id && sigById.get(tc.id) ? '(id)' : name && sigByName.get(name) ? '(name)' : '(last)'));
      }
    }
    return notes;
  }

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

  function sanitize(raw) {
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch (_) {
      return { body: raw, note: 'passthrough(non-json)' };
    }
    const notes = [];
    for (const f of DROP_FIELDS) {
      if (f in body) { delete body[f]; notes.push('-' + f); }
    }
    if (body.reasoning && typeof body.reasoning === 'object') {
      const effort = body.reasoning.effort;
      delete body.reasoning;
      if (typeof effort === 'string' && body.reasoning_effort === undefined) {
        body.reasoning_effort = effort;
        notes.push('reasoning{}->reasoning_effort');
      } else {
        notes.push('-reasoning');
      }
    }
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m && m.role === 'developer') { m.role = 'system'; notes.push('developer->system'); }
      }
    }
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
      delete body.max_completion_tokens;
      notes.push('-max_completion_tokens(dup)');
    }
    if (Array.isArray(body.messages)) notes.push(...injectSignatures(body));
    return { body: Buffer.from(JSON.stringify(body), 'utf8'), note: notes.join(' ') || 'unchanged' };
  }

  function sendJson(res, status, payload) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  function pumpRequest(sock, route, res, method, urlPath, headers, body, started) {
    return new Promise((resolve) => {
      let settled = false;
      let respSent = false;
      let headBuf = Buffer.alloc(0);
      let statusToSkip = 0;
      const tlsSock = tls.connect({ socket: sock, servername: UP_HOST });

      const settle = (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearTimeout(hsTimer);
          resolve(v);
        }
      };

      let hsTimer = null;
      const fail = (msg) => {
        try { tlsSock.destroy(); } catch (_) {}
        clearTimeout(hsTimer);
        if (respSent || res.headersSent || res.writableEnded) settle({ ok: true });
        else settle({ ok: false, err: msg });
      };

      const timer = setTimeout(() => fail('no response headers in ' + HEADER_TIMEOUT_MS + 'ms'), HEADER_TIMEOUT_MS);
      hsTimer = setTimeout(() => fail('tls handshake stuck for ' + TLS_HANDSHAKE_TIMEOUT_MS + 'ms'), TLS_HANDSHAKE_TIMEOUT_MS);

      tlsSock.on('error', (e) => fail('tls: ' + e.message));

      tlsSock.once('secureConnect', () => {
        clearTimeout(hsTimer);
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
        for (;;) {
          const idx = headBuf.indexOf('\r\n\r\n');
          if (idx === -1) {
            if (headBuf.length > 256 * 1024) fail('response headers too large');
            return;
          }
          const headText = headBuf.slice(0, idx).toString('latin1');
          const lines = headText.split('\r\n');
          const m = lines[0].match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/);
          const status = m ? Number(m[1]) : 502;
          const leftover = headBuf.slice(idx + 4);
          if (status >= 100 && status < 200 && status !== 101) {
            if (statusToSkip++ > 5) { fail('too many 1xx responses'); return; }
            headBuf = leftover;
            continue;
          }
          respSent = true;
          tlsSock.removeListener('data', onData);
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
          const rest = leftover;
          const isError = status >= 400;
          let errBuf = Buffer.alloc(0);
          const collect = (b) => {
            if (isError && errBuf.length < 4096) errBuf = Buffer.concat([errBuf, b]);
          };
          tlsSock.on('end', () => {
            if (isError) log('  <- upstream error body:', errBuf.toString('utf8').replace(/\s+/g, ' ').slice(0, 400));
          });
          const harvest = makeHarvester();
          const forward = (b) => { collect(b); harvest(b); return res.write(b); };

          if (chunked) {
            const decode = makeDechunker((b) => { forward(b); });
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
            if (rest.length) forward(rest);
            tlsSock.on('data', (b) => {
              if (!forward(b)) { tlsSock.pause(); res.once('drain', () => tlsSock.resume()); }
            });
            tlsSock.on('end', () => { try { res.end(); } catch (_) {} });
          }
          tlsSock.on('error', () => { try { res.destroy(); } catch (_) {} });
          log(method, urlPath, '->', status, 'via', routeKey(route), `(${Date.now() - started}ms)`);
          settle({ ok: true });
          return;
        }
      });

      res.on('close', () => {
        try { tlsSock.destroy(); } catch (_) {}
        settle({ ok: true });
      });
    });
  }

  function bufferedRequest(route, method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
      openRoute(route, UP_HOST, UP_PORT, PROXY_HOST, CONNECT_TIMEOUT_MS).then((sock) => {
        const tlsSock = tls.connect({ socket: sock, servername: UP_HOST });
        let headBuf = Buffer.alloc(0);
        let parsed = false;
        let status = 0;
        let statusMsg = '';
        const outHeaders = {};
        let chunked = false;
        const chunks = [];
        let finished = false;
        const timer = setTimeout(() => {
          try { tlsSock.destroy(); } catch (_) {}
          reject(new Error('timeout after 60s'));
        }, 60000);

        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ status, statusMsg, headers: outHeaders, body: Buffer.concat(chunks) });
        };
        const fail = (e) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { tlsSock.destroy(); } catch (_) {}
          reject(e);
        };

        tlsSock.on('error', fail);
        tlsSock.once('secureConnect', () => {
          const h = {};
          for (const [k, v] of Object.entries(headers)) {
            const key = k.toLowerCase();
            if (HOP_BY_HOP.has(key) || v === undefined || v === null) continue;
            h[key] = v;
          }
          h['host'] = UP_HOST;
          h['connection'] = 'close';
          h['content-length'] = String(body.length);
          let head = `${method} ${urlPath} HTTP/1.1\r\n`;
          for (const [k, v] of Object.entries(h)) head += `${k}: ${v}\r\n`;
          head += '\r\n';
          tlsSock.write(head);
          if (body.length) tlsSock.write(body);
        });

        tlsSock.on('data', (c) => {
          if (parsed) return;
          headBuf = Buffer.concat([headBuf, c]);
          const idx = headBuf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const lines = headBuf.slice(0, idx).toString('latin1').split('\r\n');
          const m = lines[0].match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/);
          status = m ? Number(m[1]) : 502;
          statusMsg = m && m[2] ? m[2] : '';
          for (let i = 1; i < lines.length; i++) {
            const p = lines[i].indexOf(':');
            if (p <= 0) continue;
            const key = lines[i].slice(0, p).trim().toLowerCase();
            const val = lines[i].slice(p + 1).trim();
            if (key === 'transfer-encoding' && /chunked/i.test(val)) chunked = true;
            if (HOP_BY_HOP.has(key)) continue;
            outHeaders[key] = val;
          }
          parsed = true;
          tlsSock.removeAllListeners('data');
          const rest = headBuf.slice(idx + 4);
          if (chunked) {
            const decode = makeDechunker((b) => chunks.push(b));
            tlsSock.on('data', (b) => { try { decode(b); } catch (e) { fail(e); } });
            tlsSock.on('end', done);
            if (rest.length) decode(rest);
          } else {
            if (rest.length) chunks.push(rest);
            tlsSock.on('data', (b) => chunks.push(b));
            tlsSock.on('end', done);
          }
        });
      }).catch(reject);
    });
  }

  async function handleModels(req, res) {
    const started = Date.now();
    const headers = { accept: 'application/json', ...authHeaders(req) };
    const errors = [];

    for (const pass of [true, false]) {
      for (const route of ROUTES) {
        const key = routeKey(route);
        if (pass && Date.now() < (cooldownUntil.get(key) || 0)) continue;
        try {
          const r = await bufferedRequest(route, 'GET', UP_PREFIX + '/models', headers, Buffer.alloc(0));
          if (r.status !== 200) {
            log('GET /v1/models -> upstream', r.status, r.body.toString('utf8').slice(0, 200), 'via', key);
            return sendJson(res, r.status, r.body.toString('utf8'));
          }
          const parsed = JSON.parse(r.body.toString('utf8'));
          const data = (parsed.data || [])
            .map((m) => ({
              id: String(m.id || '').replace(/^models\//, ''),
              object: 'model',
              owned_by: m.owned_by || 'google',
              display_name: m.display_name,
            }))
            .filter((m) => m.id && !HIDE_MODEL_RE.test(m.id));
          log('GET /v1/models -> 200,', data.length, 'chat models,', `${Date.now() - started}ms via`, key);
          return sendJson(res, 200, JSON.stringify({ object: 'list', data }));
        } catch (e) {
          errors.push(`${key}: ${e.message}`);
          cooldownUntil.set(key, Date.now() + ROUTE_COOLDOWN_MS);
          log('GET /v1/models route failed:', key, '-', e.message);
        }
      }
    }
    sendJson(res, 502, { error: { message: 'relay: no working route. ' + errors.join('; '), type: 'upstream_error' } });
  }

  function handleChat(req, res, raw) {
    const started = Date.now();
    const { body, note } = sanitize(raw);
    const headers = { 'content-type': 'application/json', ...authHeaders(req) };

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
        const outcome = await pumpRequest(sock, route, res, 'POST', UP_PREFIX + '/chat/completions', headers, body, started);
        if (outcome.ok) {
          log('POST /chat/completions body=' + raw.length + 'B via', key, '|', note);
          return true;
        }
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

      log('ALL ROUTES FAILED for POST /chat/completions |', errors.join('; '));
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: { message: 'relay: no working route. ' + (errors.join('; ') || 'all routes are cooling down'), type: 'upstream_error' },
        });
      } else {
        try { res.end(); } catch (_) {}
      }
    })();
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    res.setTimeout(0);

    if (url === '/health') {
      const ports = PROXY_PORTS.map((p) => probeProxyPort(p, PROXY_HOST));
      Promise.all(ports).then((list) => sendJson(res, 200, {
        status: 'ok',
        service: 'gemini-relay',
        listen: `http://${LISTEN_HOST}:${LISTEN_PORT}/v1`,
        upstream: `https://${UP_HOST}${UP_PREFIX}`,
        routes: ROUTES.map(routeKey),
        proxies: list,
        keyConfigured: Boolean(API_KEY),
      }));
      return;
    }

    if (url === '/__diag') {
      (async () => {
        const results = [];
        for (const route of ROUTES) {
          const key = routeKey(route);
          const t0 = Date.now();
          try {
            const r = await bufferedRequest(route, 'GET', UP_PREFIX + '/models', authHeaders(req), Buffer.alloc(0));
            results.push({ route: key, status: r.status, ms: Date.now() - t0, body: r.body.toString('utf8').slice(0, 200) });
          } catch (e) {
            results.push({ route: key, error: e.message, ms: Date.now() - t0 });
          }
        }
        sendJson(res, 200, JSON.stringify({ upstream: UP_HOST + UP_PREFIX, results }, null, 2));
      })();
      return;
    }

    if ((url === '/' || url === '/v1' || url === '/v1/models' || url === '/models') && req.method === 'GET') {
      return void handleModels(req, res);
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks = [];
      let ok = true;
      req.on('data', (c) => chunks.push(c));
      req.on('error', () => { ok = false; try { res.destroy(); } catch (_) {} });
      req.on('end', () => {
        if (!ok) return;
        handleChat(req, res, Buffer.concat(chunks));
      });
      return;
    }

    sendJson(res, 404, {
      error: { message: `Endpoint not found. Base URL is http://${LISTEN_HOST}:${LISTEN_PORT}/v1` },
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
  startGeminiRelay();
}

module.exports = { startGeminiRelay };
