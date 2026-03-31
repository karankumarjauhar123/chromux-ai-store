import { fetchGoogleShopping } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';



export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Check Cache
    const cachedTrending = cacheService.get('trending_deals');
    if (cachedTrending) {
        return res.status(200).json(cachedTrending);
    }

    try {
        console.log(`[Trending API] Cache expired/empty. Fetching fresh trending deals...`);
        
        const trendingKeywords = [
            "best selling electronics today",
            "trending fashion clothing",
            "home decor deals"
        ];
        
        const allDeals = [];
        for (const kw of trendingKeywords) {
            try {
                const results = await fetchGoogleShopping(kw);
                // Scraper returns {title, url, snippet}. Map to Product-compatible format.
                if (results && results.length > 0) {
                    const mapped = results.slice(0, 2).map(r => {
                        // Try to extract price from snippet or title
                        const priceMatch = (r.snippet || r.title || '').match(/₹[\d,]+/);
                        return {
                            title: r.title || 'Hot Deal',
                            price: priceMatch ? priceMatch[0] : 'Check Price',
                            url: r.url || '',
                            platform: r.url?.includes('flipkart') ? 'Flipkart' : r.url?.includes('myntra') ? 'Myntra' : r.url?.includes('meesho') ? 'Meesho' : 'Amazon',
                            rating: '4.0',
                            imageUrl: '' // DuckDuckGo Lite doesn't return images
                        };
                    });
                    allDeals.push(...mapped);
                }
            } catch (e) {
                console.error(`[Trending API] Failed scraping ${kw}:`, e.message);
            }
        }
        
        // Shuffle for freshness
        const finalDeals = allDeals.sort(() => Math.random() - 0.5).slice(0, 6);
        
        const responseData = {
            success: true,
            deals: finalDeals
        };

        // Cache only if we got results
        if (finalDeals.length > 0) {
            cacheService.set('trending_deals', responseData, 3600000); // 1 hour TTL
        }

        return res.status(200).json(responseData);

    } catch (e) {
        console.error("[Trending API] Major Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
