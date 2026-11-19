'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { loadEnv } = require('../src/env');

loadEnv();

const PROXY_HOST = process.env.RELAY_PROXY_HOST || '127.0.0.1';
const proxyPortsStr = process.env.RELAY_PROXY_PORTS || '12334,10808';
const PROXY_PORTS = proxyPortsStr.split(',').map((p) => parseInt(p.trim(), 10)).filter(Boolean);

const RELAYS = [
  { name: 'OpenRouter', port: Number(process.env.OPENROUTER_PORT || 8818), upstream: 'openrouter.ai' },
  { name: 'Groq', port: Number(process.env.GROQ_PORT || 8819), upstream: 'api.groq.com' },
  { name: 'Gemini', port: Number(process.env.GEMINI_PORT || 8820), upstream: 'generativelanguage.googleapis.com' },
];

function testPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const finish = (ok) => {
      try { s.destroy(); } catch (_) {}
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', (err) => reject(err));
  });
}

async function run() {
  const deep = process.argv.includes('--deep');

  console.log('\n' + '='.repeat(64));
  console.log('              LLM AGENT RELAYS - DIAGNOSTIC REPORT');
  console.log('='.repeat(64));

  console.log('\n[1] Проверка локальных прокси-клиентов (исходящие маршруты):');
  let hasWorkingProxy = false;
  for (const port of PROXY_PORTS) {
    const label = port === 12334 ? 'Hiddify mixed' : port === 10808 ? 'xray / v2rayN' : 'Custom proxy';
    const ok = await testPort(port, PROXY_HOST);
    if (ok) hasWorkingProxy = true;
    const mark = ok ? '[\x1b[32mOK\x1b[0m]  ' : '[\x1b[31mFAIL\x1b[0m]';
    console.log(`  ${mark} Порт ${port} (${label}): ${ok ? 'слушает (готов к туннелированию)' : 'не отвечает'}`);
  }

  if (!hasWorkingProxy) {
    console.log('  \x1b[33mВНИМАНИЕ: Ни один локальный прокси не запущен!\x1b[0m');
    console.log('  Запустите Hiddify (порт 12334) или v2rayN/xray (порт 10808) для обхода гео-блокировок.');
  }

  console.log('\n[2] Проверка состояния релеев:');
  for (const relay of RELAYS) {
    const isListening = await testPort(relay.port);
    if (!isListening) {
      console.log(`  [\x1b[31mOFFLINE\x1b[0m] ${relay.name} (порт ${relay.port}): сервис не запущен`);
      continue;
    }

    try {
      const res = await fetchJson(`http://127.0.0.1:${relay.port}/health`, 3000);
      if (res.status === 200 && res.data && res.data.status === 'ok') {
        const proxyInfo = (res.data.proxies || [])
          .map((p) => `${p.port}:${p.reachable ? 'OK' : 'down'}`)
          .join(', ');
        console.log(`  [\x1b[32mONLINE\x1b[0m]  ${relay.name} (порт ${relay.port}): эндпоинт /health активен`);
        console.log(`            URL: http://127.0.0.1:${relay.port}/v1`);
        console.log(`            Upstream: ${res.data.upstream}`);
        console.log(`            Статус прокси: [${proxyInfo || 'нет данных'}]`);
      } else {
        console.log(`  [\x1b[33mWARN\x1b[0m]    ${relay.name} (порт ${relay.port}): порт открыт, но /health вернул статус ${res.status}`);
      }
    } catch (e) {
      console.log(`  [\x1b[33mWARN\x1b[0m]    ${relay.name} (порт ${relay.port}): порт открыт, но /health не отвечает (${e.message})`);
    }

    if (deep) {
      console.log(`            Тестирование upstream ${relay.upstream} через все маршруты...`);
      try {
        const diag = await fetchJson(`http://127.0.0.1:${relay.port}/__diag`, 25000);
        if (diag.data && diag.data.results) {
          for (const r of diag.data.results) {
            const statusStr = r.status ? `HTTP ${r.status}` : `Error: ${r.error}`;
            const ok = r.status >= 200 && r.status < 400;
            const c = ok ? '\x1b[32m' : '\x1b[31m';
            console.log(`              - ${r.route}: ${c}${statusStr}\x1b[0m (${r.ms}ms)`);
          }
        }
      } catch (e) {
        console.log(`              ! Ошибка теста __diag: ${e.message}`);
      }
    }
  }

  console.log('\n' + '='.repeat(64));
  if (!deep) {
    console.log(' Для глубокого теста upstream используйте: node scripts/diag.js --deep');
  }
  console.log('='.repeat(64) + '\n');
}

run();
