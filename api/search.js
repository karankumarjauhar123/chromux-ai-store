import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';
import { injectAffiliateLinks } from '../lib/cuelinks.js';
import { checkRateLimit } from '../lib/rateLimiter.js';

// Optional Redis — works without it too
let redisCacheGet = async () => null;
let redisCacheSet = async () => false;
let redisEnabled = false;

try {
    const redisModule = await import('../lib/persistentCache.js');
    redisCacheGet = redisModule.redisCacheGet;
    redisCacheSet = redisModule.redisCacheSet;
    redisEnabled = redisModule.isRedisEnabled();
} catch (e) { }

// 🧠 Budget Detection from natural language queries
function extractBudgetFromQuery(query) {
    const q = query.toLowerCase().replace(/,/g, '');
    
    // "under 2000", "below 5000", "upto 3000", "tak 1500"
    const underMatch = q.match(/(?:under|below|upto|tak|within|max)\s*(\d+)/);
    if (underMatch) return { min: 0, max: parseInt(underMatch[1]) };
    
    // "2000-5000", "2000 to 5000", "2000 se 5000"
    const rangeMatch = q.match(/(\d+)\s*(?:-|to|se)\s*(\d+)/);
    if (rangeMatch) {
        const p1 = parseInt(rangeMatch[1]), p2 = parseInt(rangeMatch[2]);
        return { min: Math.min(p1, p2), max: Math.max(p1, p2) };
    }
    
    // "above 5000", "over 10000"  
    const aboveMatch = q.match(/(?:above|over|more than)\s*(\d+)/);
    if (aboveMatch) return { min: parseInt(aboveMatch[1]), max: 999999 };
    
    return { min: 0, max: 0 };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { allowed } = checkRateLimit(req, 30, 60000);
    if (!allowed) {
        res.setHeader('Retry-After', 60);
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }

    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const query = req.method === 'GET' ? req.query.q : (req.body?.query || req.body?.q);
    if (!query) return res.status(400).json({ error: 'Query is required. Use ?q= for GET.' });

    const cacheKey = 'search_v2:' + query.toLowerCase().trim();

    // ── Layer 1: In-Memory Cache ──
    const cachedResponse = cacheService.get(cacheKey);
    if (cachedResponse) {
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=7200');
        console.log(`[Search API] ⚡ Memory hit: ${query}`);
        return res.status(200).json(cachedResponse);
    }

    // ── Layer 2: Redis Cache ──
    if (redisEnabled) {
        const redisCached = await redisCacheGet(cacheKey);
        if (redisCached) {
            cacheService.set(cacheKey, redisCached, 3600000);
            res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=7200');
            console.log(`[Search API] ⚡ Redis hit: ${query}`);
            return res.status(200).json(redisCached);
        }
    }

    // ── Layer 3: Stale Memory ──
    const staleResult = cacheService.getStale(cacheKey);
    if (staleResult) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=7200');
        console.log(`[Search API] ⚡ Stale served: ${query}`);
        return res.status(200).json(staleResult.data);
    }

    // ── Layer 4: Fresh Scrape ──
    try {
        console.log(`[Search API] 🔍 Fresh scraping: ${query}`);
        const scrapedGroups = await fetchGoogleShoppingGrouped(query);

        const [affAmazon, affFlipkart, affMyntra, affMeesho] = await Promise.all([
            injectAffiliateLinks(scrapedGroups.amazon),
            injectAffiliateLinks(scrapedGroups.flipkart),
            injectAffiliateLinks(scrapedGroups.myntra),
            injectAffiliateLinks(scrapedGroups.meesho)
        ]);

        // 🧠 Server-side Smart Ranking
        const budget = extractBudgetFromQuery(query);
        
        // Calculate deal score for each product
        const scoreProduct = (p) => {
            let score = 0;
            
            // Rating (max 25)
            const r = p.ratingNumeric || parseFloat(p.rating) || 0;
            score += r >= 4.5 ? 25 : r >= 4.0 ? 22 : r >= 3.5 ? 18 : r > 0 ? Math.round((r/5)*16) : 12;
            
            // Discount (max 20)
            const discMatch = (p.discount || '').match(/(\d+)/);
            const disc = discMatch ? parseInt(discMatch[1]) : 0;
            score += Math.min(Math.round((disc/100)*20), 20);
            
            // Budget fit (max 30)
            const price = p.priceNumeric || 0;
            if (budget.max > 0 && price > 0) {
                if (price >= budget.min && price <= budget.max) {
                    score += 20 + Math.round((price / budget.max) * 10);
                } else if (price <= budget.max * 1.2) {
                    score += 12;
                } else if (price > budget.max * 1.5) {
                    score += 0;
                } else {
                    score += 5;
                }
            } else {
                score += 15;
            }
            
            // Relevance (max 15)
            const keywords = query.toLowerCase().split(/\s+/)
                .filter(w => w.length > 2 && !['under','below','above','best','top','buy','upto'].includes(w) && !/^\d+$/.test(w));
            if (keywords.length > 0) {
                const titleLower = (p.title || '').toLowerCase();
                const matches = keywords.filter(k => titleLower.includes(k)).length;
                score += Math.round((matches / keywords.length) * 15);
            } else {
                score += 15;
            }
            
            // Platform trust (max 10)
            const plat = (p.platform || '').toLowerCase();
            score += plat === 'amazon' || plat === 'flipkart' ? 10 : plat === 'myntra' ? 8 : plat === 'meesho' ? 6 : 4;
            
            p.dealScore = Math.max(0, Math.min(100, score));
            return p;
        };
        
        // Score and sort all products
        const sortByScore = (a, b) => (b.dealScore || 0) - (a.dealScore || 0);
        
        affAmazon.forEach(scoreProduct);
        affFlipkart.forEach(scoreProduct);
        affMyntra.forEach(scoreProduct);
        affMeesho.forEach(scoreProduct);
        
        affAmazon.sort(sortByScore);
        affFlipkart.sort(sortByScore);
        affMyntra.sort(sortByScore);
        affMeesho.sort(sortByScore);

        let allProducts = [...affAmazon, ...affFlipkart, ...affMyntra, ...affMeesho]
            .sort(sortByScore);

        const responseData = {
            success: true,
            query: query,
            budget: budget.max > 0 ? budget : undefined,
            allProducts: allProducts,
            grouped: {
                Amazon: affAmazon,
                Flipkart: affFlipkart,
                Myntra: affMyntra,
                Meesho: affMeesho
            }
        };

        if (allProducts.length > 0) {
            cacheService.set(cacheKey, responseData, 3600000); // 1 hour memory
            if (redisEnabled) {
                await redisCacheSet(cacheKey, responseData, 7200); // 2 hour Redis
            }
            console.log(`[Search API] ✅ ${allProducts.length} products ranked & cached (budget: ${budget.max > 0 ? '₹'+budget.min+'-₹'+budget.max : 'any'})`);
        }

        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=7200');
        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Search API] Major Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
