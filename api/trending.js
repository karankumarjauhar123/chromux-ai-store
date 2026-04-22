import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';

const TRENDING_QUERIES = [
    "best true wireless earbuds",
    "smartwatches under 2000",
    "trending mens shoes",
    "stylish kurtis for women",
    "home decor items",
    "power banks 20000mah",
    "gaming headphones",
    "backpacks for men",
    "sunglasses for men women"
];

const AFFILIATE_CONFIG = {
    amazon: { tag: 'chromuxaistor-21', param: 'tag' }
};

function injectAffiliateLinks(products) {
    if (!products) return [];
    return products.map(p => {
        try {
            if (p.url.includes('amazon')) {
                const urlObj = new URL(p.url);
                urlObj.searchParams.set(AFFILIATE_CONFIG.amazon.param, AFFILIATE_CONFIG.amazon.tag);
                p.url = urlObj.toString();
            }
        } catch(e) {}
        return p;
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const cacheKey = 'trending_feed_v3';
    const cachedTrending = cacheService.get(cacheKey);
    if (cachedTrending) return res.status(200).json(cachedTrending);

    try {
        console.log(`[Trending API] Cache empty. Fetching fresh Netflix-style feed...`);
        
        // Pick 2 random queries and merge results for variety
        const shuffled = [...TRENDING_QUERIES].sort(() => 0.5 - Math.random());
        const query1 = shuffled[0];
        const query2 = shuffled[1];
        
        console.log(`[Trending API] Using queries: "${query1}" + "${query2}"`);
        
        // Fetch both in parallel
        const [results1, results2] = await Promise.allSettled([
            fetchGoogleShoppingGrouped(query1),
            fetchGoogleShoppingGrouped(query2)
        ]);

        const r1 = results1.status === 'fulfilled' ? results1.value : { amazon: [], flipkart: [], myntra: [], meesho: [] };
        const r2 = results2.status === 'fulfilled' ? results2.value : { amazon: [], flipkart: [], myntra: [], meesho: [] };

        // Merge results from both queries
        const mergeAndShuffle = (a, b) => {
            const merged = [...(a||[]), ...(b||[])];
            // Deduplicate by URL
            const seen = new Set();
            const unique = merged.filter(item => {
                const key = item.url?.split('?')[0] || item.title;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return unique.sort(() => 0.5 - Math.random());
        };

        const finalAmazon = injectAffiliateLinks(mergeAndShuffle(r1.amazon, r2.amazon)).slice(0, 25);
        const finalFlipkart = mergeAndShuffle(r1.flipkart, r2.flipkart).slice(0, 25);
        const finalMyntra = mergeAndShuffle(r1.myntra, r2.myntra).slice(0, 20);
        const finalMeesho = mergeAndShuffle(r1.meesho, r2.meesho).slice(0, 20);

        const feeds = [];
        
        if (finalAmazon.length > 0) {
            feeds.push({ title: "Popular Deals on Amazon", platform: "Amazon", emoji: "🟠", products: finalAmazon });
        }
        if (finalFlipkart.length > 0) {
            feeds.push({ title: "Trending on Flipkart", platform: "Flipkart", emoji: "🔵", products: finalFlipkart });
        }
        if (finalMyntra.length > 0) {
            feeds.push({ title: "Fashion from Myntra", platform: "Myntra", emoji: "🩷", products: finalMyntra });
        }
        if (finalMeesho.length > 0) {
            feeds.push({ title: "Budget Steals on Meesho", platform: "Meesho", emoji: "🟣", products: finalMeesho });
        }

        // If all direct scrapers failed, create a "Hot Searches" feed from DDG as ultimate fallback
        if (feeds.length === 0) {
            console.log(`[Trending API] All scrapers empty, generating suggestion feed...`);
            feeds.push({
                title: "Try Searching",
                platform: "Suggestion",
                emoji: "🔍",
                products: TRENDING_QUERIES.slice(0, 6).map(q => ({
                    title: q.charAt(0).toUpperCase() + q.slice(1),
                    price: "Search Now",
                    url: `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=shop`,
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

        // Cache for 30 min if we got results, 5 min if empty (to retry sooner)
        const ttl = feeds.length > 0 && feeds[0].platform !== 'Suggestion' ? 1800000 : 300000;
        cacheService.set(cacheKey, responseData, ttl);

        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Trending API] Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
