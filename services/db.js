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

/** Execute with a hard 8s timeout — prevents Cloudflare 524s */
async function execute(sql, params = []) {
  return Promise.race([
    getPool().execute(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DB query timeout')), 8_000)
    ),
  ]);
}

/** Query with a hard 8s timeout */
async function query(sql, params = []) {
  return Promise.race([
    getPool().query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DB query timeout')), 8_000)
    ),
  ]);
}

module.exports = { getPool, execute, query };
