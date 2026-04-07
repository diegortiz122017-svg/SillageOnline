'use strict';

const mysql = require('mysql2/promise');
const cfg   = require('../config');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...cfg.DB,
      connectTimeout:      10_000,  // 10s to establish connection
      acquireTimeout:      10_000,  // 10s to acquire from pool
      waitForConnections:  true,
      connectionLimit:     10,
      queueLimit:          0,
      enableKeepAlive:     true,
      keepAliveInitialDelay: 10_000,
    });
    pool.on('connection', () => {
      if (!cfg.IS_PROD) console.log('🗄️  New DB connection established');
    });
  }
  return pool;
}

/** Execute with a 15s timeout and one automatic retry on timeout */
async function execute(sql, params = []) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await Promise.race([
        getPool().execute(sql, params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('DB query timeout')), 15_000)
        ),
      ]);
    } catch(e) {
      if (attempt === 2 || !e.message.includes('timeout')) throw e;
      console.warn(`DB execute timeout on attempt ${attempt}, retrying...`);
    }
  }
}

/** Query with a 15s timeout and one automatic retry on timeout */
async function query(sql, params = []) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await Promise.race([
        getPool().query(sql, params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('DB query timeout')), 15_000)
        ),
      ]);
    } catch(e) {
      if (attempt === 2 || !e.message.includes('timeout')) throw e;
      console.warn(`DB query timeout on attempt ${attempt}, retrying...`);
    }
  }
}

module.exports = { getPool, execute, query };
