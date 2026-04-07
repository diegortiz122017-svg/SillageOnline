'use strict';

/**
 * Simple in-memory TTL cache.
 * Each entry: { value, expiresAt }
 * Auto-prunes stale entries on get/set.
 */
class Cache {
  constructor(defaultTtl = 60_000) {
    this._store     = new Map();
    this._defaultTtl = defaultTtl;
    // Prune stale entries every 5 minutes
    setInterval(() => this._prune(), 5 * 60 * 1000).unref();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttl) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this._defaultTtl),
    });
    return value;
  }

  delete(key) {
    this._store.delete(key);
  }

  /** Invalidate all keys matching a prefix */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  clear() {
    this._store.clear();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) this._store.delete(key);
    }
  }

  get size() { return this._store.size; }
}

// ─── Named cache instances ────────────────────────────────────────────────────
const cfg = require('../config');

const catalogueCache = new Cache(cfg.CACHE_TTL_CATALOGUE);
const inventoryCache = new Cache(cfg.CACHE_TTL_INVENTORY);
const pricingCache   = new Cache(cfg.CACHE_TTL_PRICING);
const toolCache      = new Cache(cfg.CACHE_TTL_TOOL);
const replyCache     = new Cache(cfg.CACHE_TTL_REPLY);

/** Invalidate all data caches (call after any write) */
function invalidateDataCaches() {
  catalogueCache.clear();
  inventoryCache.clear();
  pricingCache.clear();
}

module.exports = {
  Cache,
  catalogueCache,
  inventoryCache,
  pricingCache,
  toolCache,
  replyCache,
  invalidateDataCaches,
};
