'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const targetPath = envPath || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(targetPath)) return {};

  try {
    const content = fs.readFileSync(targetPath, 'utf8');
    const parsed = {};
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
      }
      parsed[key] = val;
    }
    return parsed;
  } catch (err) {
    console.error('Failed to load .env:', err.message);
    return {};
  }
}

module.exports = { loadEnv };
