/**
 * A lightweight in-memory cache for Vercel Serverless.
 * Note: Data here may reset during "Cold Starts", but it's highly 
 * effective for back-to-back rapid requests (like chat or trending polling).
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
            expiresAt: Date.now() + ttlMillis
        });
        console.log(`[Cache] Set key: ${key} (TTL: ${ttlMillis}ms)`);
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
            this.cache.delete(key);
            console.log(`[Cache] Expired key: ${key}`);
            return null;
        }

        console.log(`[Cache] Hit key: ${key}`);
        return cached.data;
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
