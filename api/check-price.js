import { fetchGoogleShopping } from '../lib/scraper.js';
import { askMegaRouter } from '../lib/megaRouter.js';

const PRICE_EXTRACT_PROMPT = `You are a price extraction bot. Given a product title and some search snippets, extract the most likely current selling price in INR (₹).
Output ONLY the price string like "₹15,999" or "₹2,499". Nothing else. If you cannot determine the price, output "UNKNOWN".`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Missing product query/title' });
        }

        console.log(`[Price Check API] Fetching live price for: ${query}`);
        const results = await fetchGoogleShopping(query);
        
        if (results && results.length > 0) {
            // The scraper returns {title, url, snippet} — no price field directly.
            // Try to extract price from snippet text first (fast path)
            for (const r of results) {
                const priceMatch = (r.snippet || '').match(/₹[\d,]+/);
                if (priceMatch) {
                    return res.status(200).json({
                        success: true,
                        price: priceMatch[0]
                    });
                }
                // Also check title for price patterns
                const titleMatch = (r.title || '').match(/₹[\d,]+/);
                if (titleMatch) {
                    return res.status(200).json({
                        success: true,
                        price: titleMatch[0]
                    });
                }
            }
            
            // If no price found in snippets, use AI to extract from context (slower but reliable)
            const context = results.slice(0, 3).map(r => `${r.title} - ${r.snippet}`).join('\n');
            const messages = [{ role: 'user', content: `Product: "${query}"\n\nSearch results:\n${context}\n\nWhat is the current selling price?` }];
            
            const aiResult = await askMegaRouter(messages, PRICE_EXTRACT_PROMPT);
            if (aiResult && !aiResult.error && aiResult.response) {
                const price = aiResult.response.trim();
                if (price !== 'UNKNOWN' && price.includes('₹')) {
                    return res.status(200).json({ success: true, price });
                }
            }
        }
        
        return res.status(404).json({ success: false, error: 'Could not determine current price' });

    } catch (e) {
        console.error("[Price Check API] Error:", e);
        return res.status(500).json({ success: false, error: e.message });
    }
}
