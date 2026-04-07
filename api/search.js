import { fetchGoogleShopping } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';

// ============================================================
// AFFILIATE CONFIG — Change these to YOUR real affiliate IDs!
// ============================================================
const AFFILIATE_CONFIG = {
    amazon: {
        tag: 'chromuxaistor-21',
        param: 'tag'
    }
    // Others platforms (Flipkart, Myntra, Meesho) are currently DIRECT links only.
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
            urlObj.searchParams.delete('affExtParam1');

            if (urlObj.hostname.includes('amazon')) {
                urlObj.searchParams.set(AFFILIATE_CONFIG.amazon.param, AFFILIATE_CONFIG.amazon.tag);
                p.platform = p.platform || 'Amazon';
            } else if (urlObj.hostname.includes('flipkart')) {
                p.platform = p.platform || 'Flipkart';
            } else if (urlObj.hostname.includes('myntra')) {
                p.platform = p.platform || 'Myntra';
            } else if (urlObj.hostname.includes('meesho')) {
                p.platform = p.platform || 'Meesho';
            } else {
                p.platform = p.platform || 'Store';
            }

            p.url = urlObj.toString();
        } catch (e) {
            if (p.url.includes('amazon.in') || p.url.includes('amazon.com')) {
                p.url = p.url.includes('?') 
                    ? `${p.url}&${AFFILIATE_CONFIG.amazon.param}=${AFFILIATE_CONFIG.amazon.tag}`
                    : `${p.url}?${AFFILIATE_CONFIG.amazon.param}=${AFFILIATE_CONFIG.amazon.tag}`;
                p.platform = p.platform || 'Amazon';
            } else {
                console.log("Failed to clean url:", p.url);
            }
        }
        return p;
    });
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Support both GET (?q=...) and POST ({ query: "..." }) from Android app
    const query = req.method === 'GET' ? req.query.q : (req.body?.query || req.body?.q);
    if (!query) {
        return res.status(400).json({ error: 'Query is required. Use ?q= for GET or { "query": "..." } for POST.' });
    }

    const cacheKey = 'search:' + query.toLowerCase().trim();
    const cachedResponse = cacheService.get(cacheKey);
    if (cachedResponse) {
        return res.status(200).json(cachedResponse);
    }

    try {
        console.log(`[Search API] Fetching fresh results for: ${query}`);
        const results = await fetchGoogleShopping(query);
        
        let finalDeals = [];
        if (results && results.length > 0) {
            finalDeals = results.map(r => {
                // PRESERVE rich data from the scraper (images, price, rating, platform)
                // Only use fallbacks if scraper didn't provide the field
                let platform = r.platform || 'Store';
                if (!r.platform) {
                    if (r.url.includes('flipkart')) platform = 'Flipkart';
                    else if (r.url.includes('amazon')) platform = 'Amazon';
                    else if (r.url.includes('myntra')) platform = 'Myntra';
                    else if (r.url.includes('meesho')) platform = 'Meesho';
                }

                // Use scraper's price first; only regex-parse from snippet as fallback
                let price = r.price || '';
                if (!price) {
                    const priceMatch = (r.snippet || r.title || '').match(/₹[\d,]+/);
                    price = priceMatch ? priceMatch[0] : 'Check Price';
                }

                return {
                    title: r.title || 'Product',
                    price: price,
                    url: r.url || '',
                    platform: platform,
                    rating: r.rating || '4.0',
                    imageUrl: r.imageUrl || '',
                    description: r.description || r.snippet || ''
                };
            });
            
            // Inject affiliate tags
            finalDeals = injectAffiliateLinks(finalDeals);
        }

        const responseData = {
            success: true,
            query: query,
            products: finalDeals
        };

        if (finalDeals.length > 0) {
            cacheService.set(cacheKey, responseData, 3600000); // 1 hour TTL
        }

        return res.status(200).json(responseData);

    } catch (e) {
        console.error("[Search API] Major Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
