'use strict';

const mysql = require('mysql2/promise');
const cfg   = require('../config');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...cfg.DB,
      connectTimeout:      10_000,  // 10s to establish connection
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

/** Execute — no artificial timeout, let MySQL handle it */
async function execute(sql, params = []) {
  return getPool().execute(sql, params);
}

/** Query — no artificial timeout, let MySQL handle it */
async function query(sql, params = []) {
  return getPool().query(sql, params);
}

module.exports = { getPool, execute, query };
