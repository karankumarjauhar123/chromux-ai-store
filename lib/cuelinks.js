import fs from 'fs';
import path from 'path';
import { cacheService } from './cache.js';

// ============================================================
// CUELINKS AFFILIATE ENGINE 💰
// Converts ANY product URL into an affiliate-tracked URL via
// Cuelinks API. Supports: Amazon, Flipkart, Myntra, Meesho,
// Ajio, Nykaa, and 500+ other Indian e-commerce stores.
// ============================================================

// Load Cuelinks API Key
let CUELINKS_API_KEY = '';
try {
    const keysData = fs.readFileSync(path.resolve(process.cwd(), 'keys.json'), 'utf8');
    const keys = JSON.parse(keysData);
    CUELINKS_API_KEY = keys.CUELINKS_API_KEY || '';
} catch (e) { }

// Support Vercel Environment Variable
if (process.env.CUELINKS_API_KEY) {
    CUELINKS_API_KEY = process.env.CUELINKS_API_KEY;
}

// Fallback Amazon tag (used ONLY if Cuelinks API fails for Amazon URLs)
const AMAZON_FALLBACK_TAG = 'chromuxaistor-21';

// Cuelinks API Config
const CUELINKS_CID = '276837'; // The Channel ID provided by the user
const CUELINKS_SUBID = 'chromux_ai_store'; // Track earnings from AI Store

/**
 * Convert a single plain URL into a Cuelinks affiliate URL using Direct Deep Linking.
 * This is MUCH faster than hitting the API, as it just wraps the URL.
 */
async function convertToCuelinkUrl(plainUrl) {
    if (!plainUrl || plainUrl === 'SEARCH') {
        return plainUrl;
    }

    try {
        const encodedUrl = encodeURIComponent(plainUrl);
        // Using the direct linksredirect deep link format provided by the user
        const affiliateUrl = `https://linksredirect.com/?cid=${CUELINKS_CID}&source=linkkit&subid=${CUELINKS_SUBID}&url=${encodedUrl}`;
        
        return affiliateUrl;
    } catch (e) {
        console.error(`[Cuelinks] ❌ Error wrapping URL ${plainUrl.substring(0, 50)}:`, e.message);
        return plainUrl;
    }
}

/**
 * Apply Amazon fallback tag when Cuelinks API is unavailable or failed.
 * This ensures we ALWAYS earn from Amazon even if Cuelinks is down.
 */
function applyAmazonFallbackTag(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname.includes('amazon')) {
            urlObj.searchParams.delete('tag');
            urlObj.searchParams.delete('ref');
            urlObj.searchParams.delete('linkCode');
            urlObj.searchParams.set('tag', AMAZON_FALLBACK_TAG);
            return urlObj.toString();
        }
    } catch (e) {
        if (url.includes('amazon.in') || url.includes('amazon.com')) {
            return url.includes('?')
                ? `${url}&tag=${AMAZON_FALLBACK_TAG}`
                : `${url}?tag=${AMAZON_FALLBACK_TAG}`;
        }
    }
    return url;
}

/**
 * Detect platform from URL hostname.
 */
function detectPlatform(url) {
    if (!url || typeof url !== 'string') return 'Store';
    const lower = url.toLowerCase();
    if (lower.includes('amazon')) return 'Amazon';
    if (lower.includes('flipkart')) return 'Flipkart';
    if (lower.includes('myntra')) return 'Myntra';
    if (lower.includes('meesho')) return 'Meesho';
    if (lower.includes('ajio')) return 'Ajio';
    if (lower.includes('nykaa')) return 'Nykaa';
    if (lower.includes('cuelinks')) return 'Store'; // Already affiliate
    return 'Store';
}

/**
 * Generate clean search fallback URLs when AI doesn't have real product links.
 * These will also be converted to affiliate URLs by Cuelinks.
 */
function generateSearchFallback(product) {
    if (!product.url ||
        product.url.length < 15 ||
        product.url.includes('example.com') ||
        product.url.includes('...') ||
        product.url.includes('…') ||
        product.url === 'SEARCH') {

        const searchQuery = encodeURIComponent(product.title);
        if (product.platform?.toLowerCase() === 'flipkart') {
            product.url = `https://www.flipkart.com/search?q=${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'myntra') {
            product.url = `https://www.myntra.com/${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'meesho') {
            product.url = `https://www.meesho.com/search?q=${searchQuery}`;
        } else {
            product.url = `https://www.amazon.in/s?k=${searchQuery}`;
        }
    }
    return product;
}

/**
 * MAIN FUNCTION: Process an array of products and convert ALL URLs
 * to Cuelinks affiliate URLs. Falls back to Amazon tag if Cuelinks fails.
 *
 * This is the MONEY-MAKING function! Every product link that passes
 * through here earns commission when users click and buy. 💰
 *
 * @param {Array} products - Array of product objects with `url` field
 * @returns {Array} Products with affiliate URLs injected
 */
export async function injectAffiliateLinks(products) {
    if (!products || !Array.isArray(products) || products.length === 0) {
        return [];
    }

    // Step 1: Fix any fake/missing URLs with search fallbacks
    products = products.map(generateSearchFallback);

    // Step 2: Detect platform for each product
    products.forEach(p => {
        if (!p.platform || p.platform === 'Store') {
            p.platform = detectPlatform(p.url);
        }
    });

    // Step 3: Try wrapping with Cuelinks Direct Link
    if (CUELINKS_CID) {
        // Process ALL product URLs in parallel for speed
        const conversionPromises = products.map(async (product) => {
            if (!product.url || product.url === 'SEARCH') return product;

            // Optional: You can choose to skip Amazon wrapping here if Amazon approval is rejected
            // and apply fallback tag directly, but wrapping it is safe; if approved, it works.
            const originalUrl = product.url;
            product.url = await convertToCuelinkUrl(product.url);

            return product;
        });

        products = await Promise.all(conversionPromises);
        console.log(`[Cuelinks] 💰 Processed ${products.length} product links`);
    } else {
        // No Cuelinks key — fall back to Amazon-only affiliate tags
        console.log(`[Cuelinks] ⚠️ No API key configured. Using Amazon fallback only.`);
        products = products.map(p => {
            if (p.url && p.platform === 'Amazon') {
                p.url = applyAmazonFallbackTag(p.url);
            }
            return p;
        });
    }

    return products;
}

/**
 * Quick sync version for emergency/fallback scenarios where we can't await.
 * Only applies Amazon fallback tag (no Cuelinks API call).
 */
export function injectAffiliateLinksSync(products) {
    if (!products || !Array.isArray(products)) return [];
    return products.map(p => {
        p = generateSearchFallback(p);
        p.platform = p.platform || detectPlatform(p.url);
        if (p.url && p.platform === 'Amazon') {
            p.url = applyAmazonFallbackTag(p.url);
        }
        return p;
    });
}
