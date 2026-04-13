import { fetchGoogleShoppingGrouped } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';

const AFFILIATE_CONFIG = {
    amazon: { tag: 'chromuxaistor-21', param: 'tag' }
};

function injectAffiliateLinks(products) {
    if (!products || !Array.isArray(products)) return [];
    return products.map(p => {
        if (!p.url || typeof p.url !== 'string') return p;
        try {
            const urlObj = new URL(p.url);
            urlObj.searchParams.delete('tag');
            urlObj.searchParams.delete('ref');
            urlObj.searchParams.delete('linkCode');
            urlObj.searchParams.delete('affid');

            if (urlObj.hostname.includes('amazon')) {
                urlObj.searchParams.set(AFFILIATE_CONFIG.amazon.param, AFFILIATE_CONFIG.amazon.tag);
                p.platform = 'Amazon';
            }
            p.url = urlObj.toString();
        } catch (e) {
            // Backup
            if (p.url.includes('amazon.in')) {
                p.url = p.url.includes('?') 
                    ? `${p.url}&${AFFILIATE_CONFIG.amazon.param}=${AFFILIATE_CONFIG.amazon.tag}`
                    : `${p.url}?${AFFILIATE_CONFIG.amazon.param}=${AFFILIATE_CONFIG.amazon.tag}`;
            }
        }
        return p;
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const query = req.method === 'GET' ? req.query.q : (req.body?.query || req.body?.q);
    if (!query) return res.status(400).json({ error: 'Query is required. Use ?q= for GET.' });

    const cacheKey = 'search_v2:' + query.toLowerCase().trim();
    const cachedResponse = cacheService.get(cacheKey);
    if (cachedResponse) return res.status(200).json(cachedResponse);

    try {
        console.log(`[Search API] Fetching deep grouped results for: ${query}`);
        const scrapedGroups = await fetchGoogleShoppingGrouped(query);
        
        // Inject affiliate tags to Amazon
        scrapedGroups.amazon = injectAffiliateLinks(scrapedGroups.amazon);
        
        let allProducts = [
            ...scrapedGroups.amazon,
            ...scrapedGroups.flipkart,
            ...scrapedGroups.myntra,
            ...scrapedGroups.meesho
        ];

        const responseData = {
            success: true,
            query: query,
            allProducts: allProducts,
            grouped: {
                Amazon: scrapedGroups.amazon,
                Flipkart: scrapedGroups.flipkart,
                Myntra: scrapedGroups.myntra,
                Meesho: scrapedGroups.meesho
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
