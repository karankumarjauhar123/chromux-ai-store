/**
 * PERSISTENT CACHE — Upstash Redis (Free Tier: 10,000 commands/day, 256MB)
 * 
 * This replaces the in-memory cache for trending/search data.
 * Unlike in-memory cache, Redis data SURVIVES cold starts, 
 * server restarts, and Vercel function recycling.
 * 
 * Setup:
 *   1. Go to https://upstash.com → Create free account
 *   2. Create a Redis database (choose nearest region)
 *   3. Copy UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 *   4. Add to Vercel env vars or keys.json
 * 
 * Why Upstash?
 *   - FREE tier is more than enough (10k commands/day)
 *   - HTTP-based — no persistent connections needed
 *   - Official Vercel partner — zero config integration
 *   - Data persists across cold starts = INSTANT responses
 */

import fs from 'fs';
import path from 'path';

// Load keys
let REDIS_URL = '';
let REDIS_TOKEN = '';

try {
    const keysData = fs.readFileSync(path.resolve(process.cwd(), 'keys.json'), 'utf8');
    const keys = JSON.parse(keysData);
    REDIS_URL = keys.UPSTASH_REDIS_REST_URL || '';
    REDIS_TOKEN = keys.UPSTASH_REDIS_REST_TOKEN || '';
} catch (e) { }

// Vercel env vars override
if (process.env.UPSTASH_REDIS_REST_URL) REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
if (process.env.UPSTASH_REDIS_REST_TOKEN) REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const REDIS_ENABLED = REDIS_URL && REDIS_TOKEN;

if (REDIS_ENABLED) {
    console.log('[PersistentCache] ✅ Upstash Redis connected');
} else {
    console.log('[PersistentCache] ⚠️ No Redis config — using in-memory fallback only');
}

/**
 * Execute a Redis REST API command via HTTP (no npm package needed!)
 * Upstash provides a simple REST API — just fetch() calls.
 */
async function redisCommand(...args) {
    if (!REDIS_ENABLED) return null;

    try {
        const res = await fetch(`${REDIS_URL}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${REDIS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(3000) // 3s timeout for cache ops
        });

        if (!res.ok) {
            console.error(`[Redis] HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        return data.result;
    } catch (e) {
        console.error('[Redis] Command failed:', e.message);
        return null;
    }
}

/**
 * Save data to Redis with TTL (seconds)
 * Data is JSON-stringified before storage.
 */
export async function redisCacheSet(key, data, ttlSeconds = 1800) {
    if (!REDIS_ENABLED) return false;

    try {
        const jsonStr = JSON.stringify(data);
        // SET key value EX ttlSeconds
        await redisCommand('SET', key, jsonStr, 'EX', ttlSeconds);
        console.log(`[Redis] ✅ Saved: ${key} (TTL: ${ttlSeconds}s, Size: ${(jsonStr.length / 1024).toFixed(1)}KB)`);
        return true;
    } catch (e) {
        console.error(`[Redis] Set failed for ${key}:`, e.message);
        return false;
    }
}

/**
 * Get data from Redis. Returns parsed JSON or null.
 */
export async function redisCacheGet(key) {
    if (!REDIS_ENABLED) return null;

    try {
        const result = await redisCommand('GET', key);
        if (!result) return null;

        const data = JSON.parse(result);
        console.log(`[Redis] ⚡ Cache hit: ${key}`);
        return data;
    } catch (e) {
        console.error(`[Redis] Get failed for ${key}:`, e.message);
        return null;
    }
}

/**
 * Check if a key exists in Redis
 */
export async function redisCacheExists(key) {
    if (!REDIS_ENABLED) return false;
    try {
        const result = await redisCommand('EXISTS', key);
        return result === 1;
    } catch (e) {
        return false;
    }
}

/**
 * Delete a key from Redis
 */
export async function redisCacheDelete(key) {
    if (!REDIS_ENABLED) return false;
    try {
        await redisCommand('DEL', key);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Check if Redis is configured and available
 */
export function isRedisEnabled() {
    return REDIS_ENABLED;
}
