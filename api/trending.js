import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';
import { injectAffiliateLinks } from '../lib/cuelinks.js';

// ============================================================
// CATEGORY-BASED TRENDING FEED — Netflix/Amazon Home Screen Style
//
// 🔥 UNLIMITED SCALE STRATEGY (No Redis, No External DB needed!):
//
//   Vercel CDN Edge Cache does ALL the heavy lifting:
//   - s-maxage=1200 → CDN caches response for 20 min at ALL edge nodes
//   - stale-while-revalidate=86400 → Stale OK for 24 hours
//   - Cron (cron-job.org, FREE) hits /api/trending?warm=1 every 20 min
//
//   Result: Function runs ~72 times/day (cron only).
//   CDN serves UNLIMITED requests from edge. Zero cost. Zero latency.
//
//   Optional: Upstash Redis adds cold-start protection as bonus layer.
// ============================================================

const CATEGORY_FEEDS = [
    { title: "🎧 Top Earbuds & Headphones",  emoji: "🎧", query: "best earbuds headphones under 2000" },
    { title: "⌚ Trending Smartwatches",      emoji: "⌚", query: "smartwatches under 3000 best rated" },
    { title: "👟 Shoes & Sneakers",           emoji: "👟", query: "trending sneakers shoes for men women" },
    { title: "👗 Fashion & Clothing",         emoji: "👗", query: "stylish kurtis dress men shirts trending" },
    { title: "📱 Phones & Gadgets",           emoji: "📱", query: "best smartphones under 15000" },
    { title: "🏠 Home & Kitchen Essentials",  emoji: "🏠", query: "home decor kitchen gadgets trending" },
    { title: "💪 Fitness & Sports",           emoji: "💪", query: "gym fitness yoga accessories cricket bat" },
    { title: "🎒 Bags & Accessories",         emoji: "🎒", query: "backpacks bags sunglasses trending" },
    { title: "🔋 Power Banks & Chargers",     emoji: "🔋", query: "power bank 20000mah fast charger" },
    { title: "🎮 Gaming Accessories",         emoji: "🎮", query: "gaming headphones controller keyboard mouse" },
    { title: "💄 Beauty & Skincare",          emoji: "💄", query: "skincare beauty products serum cream trending" }
];

function deduplicate(products) {
    const seen = new Set();
    return products.filter(item => {
        const key = item.url?.split('?')[0] || item.title;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildCategoryCarousel(data, cat) {
    let products = deduplicate([
        ...(data.amazon || []),
        ...(data.flipkart || []),
        ...(data.myntra || []),
        ...(data.meesho || [])
    ]).sort(() => 0.5 - Math.random()).slice(0, 30);

    if (products.length > 0) {
        return { title: cat.title, platform: "Mixed", emoji: cat.emoji, products };
    }
    return null;
}

function buildPlatformCarousels(dataArray) {
    const carousels = [];
    let allAmazon = [], allFlipkart = [], allMyntra = [], allMeesho = [];

    for (const data of dataArray) {
        allAmazon.push(...(data.amazon || []));
        allFlipkart.push(...(data.flipkart || []));
        allMyntra.push(...(data.myntra || []));
        allMeesho.push(...(data.meesho || []));
    }

    let amazonProducts = deduplicate(allAmazon).sort(() => 0.5 - Math.random()).slice(0, 30);
    if (amazonProducts.length > 3) {
        carousels.push({ title: "🟠 Popular on Amazon", platform: "Amazon", emoji: "🟠", products: amazonProducts });
    }

    let flipkartProducts = deduplicate(allFlipkart).sort(() => 0.5 - Math.random()).slice(0, 30);
    if (flipkartProducts.length > 3) {
        carousels.push({ title: "🔵 Trending on Flipkart", platform: "Flipkart", emoji: "🔵", products: flipkartProducts });
    }

    let myntraProducts = deduplicate(allMyntra).sort(() => 0.5 - Math.random()).slice(0, 25);
    if (myntraProducts.length > 2) {
        carousels.push({ title: "🩷 Fashion from Myntra", platform: "Myntra", emoji: "🩷", products: myntraProducts });
    }

    let meeshoProducts = deduplicate(allMeesho).sort(() => 0.5 - Math.random()).slice(0, 25);
    if (meeshoProducts.length > 2) {
        carousels.push({ title: "🟣 Budget Steals on Meesho", platform: "Meesho", emoji: "🟣", products: meeshoProducts });
    }

    return carousels;
}

function buildDiscountCarousel(feeds) {
    let allProducts = [];
    feeds.forEach(f => allProducts.push(...f.products));

    let biggestDiscounts = allProducts
        .filter(p => p.discount && p.discount.includes('%'))
        .sort((a, b) => {
            const dA = parseInt(a.discount.replace(/[^0-9]/g, '')) || 0;
            const dB = parseInt(b.discount.replace(/[^0-9]/g, '')) || 0;
            return dB - dA;
        })
        .slice(0, 20);

    biggestDiscounts = deduplicate(biggestDiscounts);

    if (biggestDiscounts.length >= 3) {
        return { title: "💸 Biggest Discounts Right Now", platform: "Mixed", emoji: "💸", products: biggestDiscounts };
    }
    return null;
}

async function injectAffiliateIntoFeeds(feeds) {
    for (let i = 0; i < feeds.length; i++) {
        feeds[i].products = await injectAffiliateLinks(feeds[i].products);
    }
    return feeds;
}

// ============================================================
// OPTIONAL: Upstash Redis (bonus persistence layer)
// Works WITHOUT it too — Edge CDN is the primary cache.
// ============================================================
let redisCacheGet = async () => null;
let redisCacheSet = async () => false;
let redisEnabled = false;

try {
    const redisModule = await import('../lib/persistentCache.js');
    redisCacheGet = redisModule.redisCacheGet;
    redisCacheSet = redisModule.redisCacheSet;
    redisEnabled = redisModule.isRedisEnabled();
} catch (e) {
    console.log('[Trending API] Redis module not loaded — using Edge CDN only (that\'s fine!)');
}

// Background refresh lock
let isRefreshing = false;

async function fetchFreshFeeds(numCategories = 2) {
    const shuffled = [...CATEGORY_FEEDS].sort(() => 0.5 - Math.random());
    const selectedCats = shuffled.slice(0, numCategories);

    console.log(`[Trending API] Scraping ${numCategories} categories: ${selectedCats.map(c => c.title).join(', ')}`);

    const results = await Promise.allSettled(
        selectedCats.map(cat => fetchGoogleShoppingGrouped(cat.query))
    );

    const dataArray = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (dataArray.length === 0) return [];

    const feeds = [];

    for (let i = 0; i < dataArray.length; i++) {
        const carousel = buildCategoryCarousel(dataArray[i], selectedCats[i]);
        if (carousel) feeds.push(carousel);
    }

    const platformCarousels = buildPlatformCarousels(dataArray);
    feeds.push(...platformCarousels);

    if (feeds.length > 1) {
        const discountCarousel = buildDiscountCarousel(feeds);
        if (discountCarousel) feeds.unshift(discountCarousel);
    }

    await injectAffiliateIntoFeeds(feeds);
    return feeds;
}

/**
 * Save to all available caches
 */
async function saveToAllCaches(cacheKey, responseData, ttlMs) {
    cacheService.set(cacheKey, responseData, ttlMs);
    if (redisEnabled) {
        await redisCacheSet(cacheKey, responseData, Math.floor(ttlMs / 1000));
    }
}

async function backgroundRefresh(cacheKey) {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
        console.log(`[Trending API] 🔄 Background refresh...`);
        const feeds = await fetchFreshFeeds(2);
        
        // Count total products in new data
        const newProductCount = feeds.reduce((sum, f) => sum + (f.products?.length || 0), 0);
        
        // Only overwrite cache if new data is BETTER than existing
        const existing = cacheService.get(cacheKey) || cacheService.getStale(cacheKey)?.data;
        const existingProductCount = existing?.feeds?.reduce((sum, f) => sum + (f.products?.length || 0), 0) || 0;
        
        if (feeds.length > 0 && newProductCount >= existingProductCount * 0.5) {
            // New data has at least 50% of old data — safe to update
            const responseData = { success: true, feeds };
            await saveToAllCaches(cacheKey, responseData, 1800000);
            console.log(`[Trending API] ✅ Background refresh done: ${feeds.length} carousels, ${newProductCount} products`);
        } else if (feeds.length > 0) {
            console.log(`[Trending API] ⚠️ Background refresh skipped — new data (${newProductCount}) worse than cached (${existingProductCount})`);
        } else {
            console.log(`[Trending API] ⚠️ Background refresh returned 0 feeds — keeping existing cache`);
        }
    } catch (e) {
        console.error(`[Trending API] Background refresh error:`, e.message);
    } finally {
        isRefreshing = false;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const page = parseInt(req.query?.page || '1', 10);
    const pageSize = parseInt(req.query?.page_size || '20', 10);

    // ============================================================
    // WARM ENDPOINT: /api/trending?warm=1
    // Set up FREE cron at cron-job.org → every 20 min
    // URL: https://chromux-ai-store.vercel.app/api/trending?warm=1
    // This keeps Edge CDN + Redis always warm = instant for users!
    // ============================================================
    if (req.query?.warm === '1') {
        const cacheKey = 'trending_feed_v4';

        console.log('[Trending API] ♨️ Warm-up: scraping fresh data...');
        const feeds = await fetchFreshFeeds(2);
        const newCount = feeds.reduce((sum, f) => sum + (f.products?.length || 0), 0);
        
        // Only save if we got decent data
        const existing = cacheService.get(cacheKey);
        const existingCount = existing?.feeds?.reduce((sum, f) => sum + (f.products?.length || 0), 0) || 0;
        
        if (feeds.length > 0 && newCount >= existingCount * 0.5) {
            const responseData = { success: true, feeds };
            await saveToAllCaches(cacheKey, responseData, 1800000);
            console.log(`[Trending API] ♨️ Warm complete: ${feeds.length} carousels, ${newCount} products → Memory + Redis`);
        } else {
            console.log(`[Trending API] ♨️ Warm skipped — new (${newCount}) worse than cached (${existingCount})`);
        }

        // Important: Edge CDN caches THIS response too!
        res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
        return res.status(200).json({
            warm: true,
            redis: redisEnabled,
            feeds: feeds.length,
            cachedAt: new Date().toISOString()
        });
    }

    // ============================================================
    // PAGE 2+: Grid products for infinite scroll
    // ============================================================
    if (page >= 2) {
        const gridCacheKey = `trending_grid_page_${page}`;

        // In-memory check
        const cachedGrid = cacheService.get(gridCacheKey);
        if (cachedGrid) {
            res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
            return res.status(200).json(cachedGrid);
        }

        // Redis check (if available)
        if (redisEnabled) {
            const redisGrid = await redisCacheGet(gridCacheKey);
            if (redisGrid) {
                cacheService.set(gridCacheKey, redisGrid, 1200000);
                res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
                return res.status(200).json(redisGrid);
            }
        }

        try {
            const catIndex = (page - 2) % CATEGORY_FEEDS.length;
            const shuffled = [...CATEGORY_FEEDS].sort(() => 0.5 - Math.random());
            const cat = shuffled[catIndex] || shuffled[0];

            console.log(`[Trending API] Page ${page}: Scraping "${cat.title}"`);

            const result = await fetchGoogleShoppingGrouped(cat.query);
            let gridProducts = deduplicate([
                ...(result.amazon || []),
                ...(result.flipkart || []),
                ...(result.myntra || []),
                ...(result.meesho || [])
            ]).sort(() => 0.5 - Math.random()).slice(0, pageSize);

            gridProducts = await injectAffiliateLinks(gridProducts);

            const hasMore = gridProducts.length >= 5;
            const gridResponse = {
                success: true,
                gridProducts,
                hasMore: hasMore && page < 10,
                nextPage: page + 1,
                category: cat.title
            };

            await saveToAllCaches(gridCacheKey, gridResponse, 1200000);
            res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
            console.log(`[Trending API] Page ${page}: ✅ ${gridProducts.length} products cached`);
            return res.status(200).json(gridResponse);
        } catch (e) {
            console.error(`[Trending API] Page ${page} error:`, e.message);
            return res.status(200).json({ success: true, gridProducts: [], hasMore: false, nextPage: page + 1 });
        }
    }

    // ============================================================
    // PAGE 1: CAROUSELS — Multi-Layer Cache
    //
    // Priority: Memory → Redis → Stale → Fresh Scrape
    //
    // With cron warm-up, 99.9% requests served from Edge CDN.
    // Function almost NEVER executes for real users!
    // ============================================================
    const cacheKey = 'trending_feed_v4';

    // ── Layer 1: In-Memory (same instance) ──
    const memCached = cacheService.get(cacheKey);
    if (memCached) {
        res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
        console.log(`[Trending API] ⚡ MEMORY cache hit`);
        return res.status(200).json(memCached);
    }

    // ── Layer 2: Redis Persistent (cold start safe) ──
    if (redisEnabled) {
        const redisCached = await redisCacheGet(cacheKey);
        if (redisCached) {
            cacheService.set(cacheKey, redisCached, 1800000);
            res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
            console.log(`[Trending API] ⚡ REDIS cache hit (cold start survived!)`);
            backgroundRefresh(cacheKey);
            return res.status(200).json(redisCached);
        }
    }

    // ── Layer 3: Stale Memory ──
    const staleResult = cacheService.getStale(cacheKey);
    if (staleResult) {
        console.log(`[Trending API] ⚡ STALE data served, refreshing background...`);
        backgroundRefresh(cacheKey);
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
        return res.status(200).json(staleResult.data);
    }

    // ── Layer 4: Fresh Scrape (only on absolute first request ever) ──
    try {
        console.log(`[Trending API] ❄️ COLD START — scraping fresh...`);

        const feeds = await fetchFreshFeeds(2);

        if (feeds.length === 0) {
            feeds.push({
                title: "Try Searching",
                platform: "Suggestion",
                emoji: "🔍",
                products: CATEGORY_FEEDS.slice(0, 6).map(cat => ({
                    title: cat.title.replace(/^[^\s]+ /, ''),
                    price: "Search Now",
                    url: `https://www.google.com/search?q=${encodeURIComponent(cat.query)}&tbm=shop`,
                    imageUrl: '',
                    platform: 'Suggestion',
                    rating: '4.0',
                    ratingNumeric: 4.0,
                    priceNumeric: 0,
                    discount: '',
                    isSuggestion: true
                }))
            });
        }

        const responseData = { success: true, feeds };
        const ttl = feeds.length > 0 && feeds[0].platform !== 'Suggestion' ? 1800000 : 300000;
        await saveToAllCaches(cacheKey, responseData, ttl);

        // 🔥 Key header: Vercel CDN caches this for 20 min, stale OK for 24 hours
        res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=86400');
        console.log(`[Trending API] ✅ Cold start done: ${feeds.length} carousels`);
        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Trending API] Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
