'use strict';

const path = require('path');
const { loadEnv } = require('./src/env');
const { startOpenRouterRelay } = require('./relays/openrouter-relay');
const { startGroqRelay } = require('./relays/groq-relay');
const { startGeminiRelay } = require('./relays/gemini-relay');

loadEnv();

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    relays: ['openrouter', 'groq', 'gemini'],
    host: process.env.RELAY_LISTEN_HOST || '127.0.0.1',
  };

  for (const arg of args) {
    if (arg.startsWith('--relays=')) {
      options.relays = arg.slice(9).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice(7).trim();
    }
  }

  return options;
}

function main() {
  const options = parseArgs();
  const servers = [];

  console.log('\n' + '='.repeat(62));
  console.log('              LLM Agent Relays - Unified Runner');
  console.log('='.repeat(62));

  const proxyPorts = process.env.RELAY_PROXY_PORTS || '12334,10808';
  console.log(` Target Listen Host : ${options.host}`);
  console.log(` Proxy Outbound     : ${process.env.RELAY_PROXY_HOST || '127.0.0.1'} [${proxyPorts}]`);
  console.log(` Selected Relays    : ${options.relays.join(', ')}`);
  console.log('-'.repeat(62));

  if (options.relays.includes('openrouter')) {
    try {
      const s = startOpenRouterRelay({ host: options.host, exitOnError: false });
      servers.push({ name: 'OpenRouter', server: s, port: process.env.OPENROUTER_PORT || 8818 });
    } catch (e) {
      console.error('Failed to start OpenRouter relay:', e.message);
    }
  }

  if (options.relays.includes('groq')) {
    try {
      const s = startGroqRelay({ host: options.host, exitOnError: false });
      servers.push({ name: 'Groq', server: s, port: process.env.GROQ_PORT || 8819 });
    } catch (e) {
      console.error('Failed to start Groq relay:', e.message);
    }
  }

  if (options.relays.includes('gemini')) {
    try {
      const s = startGeminiRelay({ host: options.host, exitOnError: false });
      servers.push({ name: 'Gemini', server: s, port: process.env.GEMINI_PORT || 8820 });
    } catch (e) {
      console.error('Failed to start Gemini relay:', e.message);
    }
  }

  console.log('='.repeat(62));
  console.log(' Ready for AutoClaw, OpenClaw, and OpenAI-compatible clients.');
  console.log(' Press Ctrl+C to stop all relays.\n');

  function shutdown() {
    console.log('\nStopping all relays...');
    for (const item of servers) {
      try {
        if (item.server && item.server.close) {
          item.server.close();
          console.log(` - Closed ${item.name} relay`);
        }
      } catch (_) {}
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
