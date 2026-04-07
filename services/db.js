'use strict';

const mysql = require('mysql2/promise');
const cfg   = require('../config');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(cfg.DB);
    pool.on('connection', () => {
      if (!cfg.IS_PROD) console.log('🗄️  New DB connection established');
    });
  }
  return pool;
}

/** Shorthand for pool.execute */
async function execute(sql, params = []) {
  return getPool().execute(sql, params);
}

/** Shorthand for pool.query */
async function query(sql, params = []) {
  return getPool().query(sql, params);
}

module.exports = { getPool, execute, query };
