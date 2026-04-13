import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';

const TRENDING_QUERIES = [
    "best true wireless earbuds",
    "smartwatches under 2000",
    "trending mens shoes",
    "stylish kurtis for women",
    "home decor items",
    "power banks 20000mah"
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

    const cacheKey = 'trending_feed_v2';
    const cachedTrending = cacheService.get(cacheKey);
    if (cachedTrending) return res.status(200).json(cachedTrending);

    try {
        console.log(`[Trending API] Cache empty. Fetching fresh Netflix-style feed...`);
        
        // Pick 1 random query to avoid Vercel timeout (each call does 4 parallel platform scrapes internally)
        const randomQuery = TRENDING_QUERIES[Math.floor(Math.random() * TRENDING_QUERIES.length)];
        
        const results = await fetchGoogleShoppingGrouped(randomQuery);

        const shuffle = (arr) => [...(arr||[])].sort(() => 0.5 - Math.random());

        const finalAmazon = injectAffiliateLinks(shuffle(results.amazon)).slice(0, 20);
        const finalFlipkart = shuffle(results.flipkart).slice(0, 20);
        const finalMyntra = shuffle(results.myntra).slice(0, 20);
        const finalMeesho = shuffle(results.meesho).slice(0, 20);

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

        const responseData = { success: true, feeds: feeds };

        if (feeds.length > 0) {
            cacheService.set(cacheKey, responseData, 3600000); // 1 hr TTL
        }

        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Trending API] Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
