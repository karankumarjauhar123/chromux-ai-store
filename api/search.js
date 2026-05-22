import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';
import { injectAffiliateLinks } from '../lib/cuelinks.js';
import { checkRateLimit } from '../lib/rateLimiter.js';

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
    const cachedResponse = cacheService.get(cacheKey);
    if (cachedResponse) return res.status(200).json(cachedResponse);

    try {
        console.log(`[Search API] Fetching deep grouped results for: ${query}`);
        const scrapedGroups = await fetchGoogleShoppingGrouped(query);
        
        // Inject Cuelinks affiliate tags to ALL platforms 💰
        const [affAmazon, affFlipkart, affMyntra, affMeesho] = await Promise.all([
            injectAffiliateLinks(scrapedGroups.amazon),
            injectAffiliateLinks(scrapedGroups.flipkart),
            injectAffiliateLinks(scrapedGroups.myntra),
            injectAffiliateLinks(scrapedGroups.meesho)
        ]);

        
        let allProducts = [
            ...affAmazon,
            ...affFlipkart,
            ...affMyntra,
            ...affMeesho
        ];

        const responseData = {
            success: true,
            query: query,
            allProducts: allProducts,
            grouped: {
                Amazon: affAmazon,
                Flipkart: affFlipkart,
                Myntra: affMyntra,
                Meesho: affMeesho
            }
        };

        if (allProducts.length > 0) {
            cacheService.set(cacheKey, responseData, 3600000); // 1 hour
        }

        return res.status(200).json(responseData);
    } catch (e) {
        console.error("[Search API] Major Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
