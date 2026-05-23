import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';
import { injectAffiliateLinks } from '../lib/cuelinks.js';

// ============================================================
// CATEGORY-BASED TRENDING FEED — Netflix/Amazon Home Screen Style
// Each category = 1 horizontal carousel in the app UI
// We fetch 2 categories (to avoid scraper overload) and then
// split the results into multiple category carousels.
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

/**
 * Deduplicate products by URL base path
 */
function deduplicate(products) {
    const seen = new Set();
    return products.filter(item => {
        const key = item.url?.split('?')[0] || item.title;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Pagination support: page=1 (carousels), page=2+ (grid products for infinite scroll)
    const page = parseInt(req.query?.page || '1', 10);
    const pageSize = parseInt(req.query?.page_size || '20', 10);

    // ============================================================
    // PAGE 2+: Return flat grid products for infinite scroll
    // ============================================================
    if (page >= 2) {
        const gridCacheKey = `trending_grid_page_${page}`;
        const cachedGrid = cacheService.get(gridCacheKey);
        if (cachedGrid) return res.status(200).json(cachedGrid);

        try {
            // Pick 1 random category per page (lightweight — avoids scraper overload)
            const catIndex = (page - 2) % CATEGORY_FEEDS.length;
            const shuffled = [...CATEGORY_FEEDS].sort(() => 0.5 - Math.random());
            const cat = shuffled[catIndex] || shuffled[0];

            console.log(`[Trending API] Page ${page}: Fetching grid products for "${cat.title}"`);

            const result = await fetchGoogleShoppingGrouped(cat.query);
            let gridProducts = deduplicate([
                ...(result.amazon || []),
                ...(result.flipkart || []),
                ...(result.myntra || []),
                ...(result.meesho || [])
            ]).sort(() => 0.5 - Math.random()).slice(0, pageSize);

            gridProducts = await injectAffiliateLinks(gridProducts);

            const hasMore = gridProducts.length >= 5; // If we got decent results, likely more available
            const gridResponse = {
                success: true,
                gridProducts: gridProducts,
                hasMore: hasMore && page < 10, // Cap at 10 pages max
                nextPage: page + 1,
                category: cat.title
            };

            // Cache grid pages for 20 minutes
            cacheService.set(gridCacheKey, gridResponse, 1200000);
            console.log(`[Trending API] Page ${page}: ✅ ${gridProducts.length} grid products`);
            return res.status(200).json(gridResponse);
        } catch (e) {
            console.error(`[Trending API] Page ${page} error:`, e.message);
            return res.status(200).json({ success: true, gridProducts: [], hasMore: false, nextPage: page + 1 });
        }
    }

    // ============================================================
    // PAGE 1: Return carousels (existing behavior — no breaking change)
    // ============================================================
    const cacheKey = 'trending_feed_v4';
    const cachedTrending = cacheService.get(cacheKey);
    if (cachedTrending) return res.status(200).json(cachedTrending);

    try {
        console.log(`[Trending API] Cache empty. Building rich home feed...`);
        
        // Pick 2 random categories to fetch (avoids scraper overload/rate limiting)
        const shuffled = [...CATEGORY_FEEDS].sort(() => 0.5 - Math.random());
        const cat1 = shuffled[0];
        const cat2 = shuffled[1];
        
        console.log(`[Trending API] Fetching: "${cat1.title}" + "${cat2.title}"`);
        
        // Fetch 2 categories in parallel (safe — scrapers can handle 2 concurrent)
        const [result1, result2] = await Promise.allSettled([
            fetchGoogleShoppingGrouped(cat1.query),
            fetchGoogleShoppingGrouped(cat2.query)
        ]);

        const data1 = result1.status === 'fulfilled' ? result1.value : { amazon: [], flipkart: [], myntra: [], meesho: [] };
        const data2 = result2.status === 'fulfilled' ? result2.value : { amazon: [], flipkart: [], myntra: [], meesho: [] };

        const feeds = [];

        // ---- CAROUSEL 1: Category 1 (Mixed all platforms) ----
        let cat1Products = deduplicate([
            ...(data1.amazon || []),
            ...(data1.flipkart || []),
            ...(data1.myntra || []),
            ...(data1.meesho || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 15);

        if (cat1Products.length > 0) {
            cat1Products = await injectAffiliateLinks(cat1Products);
            feeds.push({
                title: cat1.title,
                platform: "Mixed",
                emoji: cat1.emoji,
                products: cat1Products
            });
        }

        // ---- CAROUSEL 2: Category 2 (Mixed all platforms) ----
        let cat2Products = deduplicate([
            ...(data2.amazon || []),
            ...(data2.flipkart || []),
            ...(data2.myntra || []),
            ...(data2.meesho || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 15);

        if (cat2Products.length > 0) {
            cat2Products = await injectAffiliateLinks(cat2Products);
            feeds.push({
                title: cat2.title,
                platform: "Mixed",
                emoji: cat2.emoji,
                products: cat2Products
            });
        }

        // ---- CAROUSEL 3: "Popular on Amazon" (Amazon-only picks from both categories) ----
        let amazonProducts = deduplicate([
            ...(data1.amazon || []),
            ...(data2.amazon || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 15);

        if (amazonProducts.length > 3) {
            amazonProducts = await injectAffiliateLinks(amazonProducts);
            feeds.push({
                title: "🟠 Popular on Amazon",
                platform: "Amazon",
                emoji: "🟠",
                products: amazonProducts
            });
        }

        // ---- CAROUSEL 4: "Trending on Flipkart" (Flipkart-only from both categories) ----
        let flipkartProducts = deduplicate([
            ...(data1.flipkart || []),
            ...(data2.flipkart || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 15);

        if (flipkartProducts.length > 3) {
            flipkartProducts = await injectAffiliateLinks(flipkartProducts);
            feeds.push({
                title: "🔵 Trending on Flipkart",
                platform: "Flipkart",
                emoji: "🔵",
                products: flipkartProducts
            });
        }

        // ---- CAROUSEL 5: "Fashion from Myntra" (if we got Myntra data) ----
        let myntraProducts = deduplicate([
            ...(data1.myntra || []),
            ...(data2.myntra || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 12);

        if (myntraProducts.length > 2) {
            myntraProducts = await injectAffiliateLinks(myntraProducts);
            feeds.push({
                title: "🩷 Fashion from Myntra",
                platform: "Myntra",
                emoji: "🩷",
                products: myntraProducts
            });
        }

        // ---- CAROUSEL 6: "Budget Steals on Meesho" (if we got Meesho data) ----
        let meeshoProducts = deduplicate([
            ...(data1.meesho || []),
            ...(data2.meesho || [])
        ]).sort(() => 0.5 - Math.random()).slice(0, 12);

        if (meeshoProducts.length > 2) {
            meeshoProducts = await injectAffiliateLinks(meeshoProducts);
            feeds.push({
                title: "🟣 Budget Steals on Meesho",
                platform: "Meesho",
                emoji: "🟣",
                products: meeshoProducts
            });
        }

        // ---- BONUS: "💸 Biggest Discounts" carousel at the TOP ----
        if (feeds.length > 1) {
            let allProducts = [];
            feeds.forEach(f => allProducts.push(...f.products));
            
            let biggestDiscounts = allProducts
                .filter(p => p.discount && p.discount.includes('%'))
                .sort((a, b) => {
                    const dA = parseInt(a.discount.replace(/[^0-9]/g, '')) || 0;
                    const dB = parseInt(b.discount.replace(/[^0-9]/g, '')) || 0;
                    return dB - dA;
                })
                .slice(0, 12);
            
            // Deduplicate (these are already affiliate-wrapped)
            biggestDiscounts = deduplicate(biggestDiscounts);
            
            if (biggestDiscounts.length >= 3) {
                feeds.unshift({
                    title: "💸 Biggest Discounts Right Now",
                    platform: "Mixed",
                    emoji: "💸",
                    products: biggestDiscounts
                });
            }
        }

        // Fallback if everything failed
        if (feeds.length === 0) {
            console.log(`[Trending API] All scrapers empty, generating suggestion feed...`);
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

        const responseData = { success: true, feeds: feeds };

        // Cache for 30 min if we got results, 5 min if empty
        const ttl = feeds.length > 0 && feeds[0].platform !== 'Suggestion' ? 1800000 : 300000;
        cacheService.set(cacheKey, responseData, ttl);

        console.log(`[Trending API] ✅ Built ${feeds.length} carousels for home feed`);
        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Trending API] Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
