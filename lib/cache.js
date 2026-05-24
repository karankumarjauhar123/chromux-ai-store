/**
 * Enhanced in-memory cache for Vercel Serverless with stale-while-revalidate.
 * 
 * Features:
 * - Standard get/set with TTL
 * - getStale(): Returns expired data (up to 2x TTL) to serve instantly
 *   while background refresh happens — eliminates blocking waits!
 * - Automatic cleanup of very old entries
 */

class CacheService {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Set a value in the cache with a Time-To-Live (TTL)
     * @param {string} key Cache key
     * @param {any} data Data to cache
     * @param {number} ttlMillis Time to live in milliseconds
     */
    set(key, data, ttlMillis = 3600000) { // default 1 hour
        this.cache.set(key, {
            data,
            createdAt: Date.now(),
            expiresAt: Date.now() + ttlMillis,
            ttl: ttlMillis
        });
    }

    /**
     * Get a value from the cache if it hasn't expired.
     * @param {string} key Cache key
     * @returns {any|null} The cached data, or null if missing/expired.
     */
    get(key) {
        if (!this.cache.has(key)) return null;

        const cached = this.cache.get(key);
        if (Date.now() > cached.expiresAt) {
            // Don't delete immediately — getStale() might need it
            console.log(`[Cache] Expired key: ${key} (keeping for stale serving)`);
            return null;
        }

        return cached.data;
    }

    /**
     * Get stale data — returns cached data even if expired,
     * as long as it's within 2x the original TTL.
     * Perfect for "serve stale, refresh in background" pattern.
     * 
     * @param {string} key Cache key
     * @returns {{ data: any, isStale: boolean } | null}
     */
    getStale(key) {
        if (!this.cache.has(key)) return null;

        const cached = this.cache.get(key);
        const now = Date.now();

        // Still fresh
        if (now <= cached.expiresAt) {
            return { data: cached.data, isStale: false };
        }

        // Stale but within grace period (2x TTL from creation)
        const maxStaleTime = cached.createdAt + (cached.ttl * 2);
        if (now <= maxStaleTime) {
            console.log(`[Cache] Serving stale data for: ${key}`);
            return { data: cached.data, isStale: true };
        }

        // Too old — delete and return null
        this.cache.delete(key);
        console.log(`[Cache] Purged very old key: ${key}`);
        return null;
    }

    /**
     * Check if a key exists (fresh or stale)
     */
    has(key) {
        return this.cache.has(key);
    }

    /**
     * Clear the cache.
     */
    clear() {
        this.cache.clear();
        console.log(`[Cache] Cleared all entries.`);
    }
}

// Export a singleton instance
export const cacheService = new CacheService();
