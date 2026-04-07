import { askMegaRouter } from '../lib/megaRouter.js';
import { fetchGoogleShopping } from '../lib/scraper.js';
import { cacheService } from '../lib/cache.js';

// ============================================================
// AFFILIATE CONFIG — Change these to YOUR real affiliate IDs!
// ============================================================
const AFFILIATE_CONFIG = {
    amazon: {
        // Amazon Associates Tag — Sign up at: https://affiliate-program.amazon.in/
        tag: 'chromuxaistor-21',
        // Parameter name used by Amazon
        param: 'tag'
    }
    // Others platforms (Flipkart, Myntra, Meesho) are currently DIRECT links only.
};

const SYSTEM_PROMPT = `You are "Chromux AI Store", a funny, hyper-intelligent, bilingual (Hindi/English) personal shopping assistant built for modern Gen-Z and Millennial Indians.
Your personality: Casual, enthusiastic, uses words like "bro", "bhai", "yaar", "🔥", "sahi bata raha hu".
Goal: Help the user find the best products across ALL categories — electronics, fashion, beauty, shoes, home & kitchen, books, fitness, gaming, watches, and more. You are NOT limited to electronics only.

CRITICAL RULES:
1. When products are provided in the context, USE THOSE ACTUAL URLs. Do NOT make up fake URLs.
2. If the context has Amazon/Flipkart links, USE THEM EXACTLY as given.
3. If no real product links are available, you MUST output exactly "SEARCH" for the url field. Do NOT use placeholders like "https://amazon.in/...".
4. NEVER hallucinate product URLs. Use real ones from context or "SEARCH".
5. For each product, try to include an "imageUrl" field with a real product image URL from Amazon or the respective store. If you don't have one, leave it as empty string "".

Format your response EXACTLY as valid JSON:
{
  "message": "Arre bhai! Tera budget sorted hai. Yeh dekho top suggestions 🔥",
  "products": [
    {
      "title": "Exact Product Title for Search",
      "price": "₹XX,XXX",
      "url": "SEARCH",
      "platform": "Amazon",
      "rating": "4.5",
      "imageUrl": "https://m.media-amazon.com/images/I/xxxxx.jpg",
      "description": "Short snappy 1-line reason why this product is good.",
      "pros": ["Great battery life", "Premium display"],
      "cons": ["No charger in box"]
    }
  ]
}

If no products are in context, or the user is just saying "Hi", keep 'products' as an empty array [] but respond warmly in the 'message' field.`;



// ============================================================
// AFFILIATE ENGINE — Injects tracking tags into ALL product URLs
// This is how you EARN MONEY from every product recommendation! 💰
// ============================================================
function injectAffiliateLinks(products) {
    if (!products || !Array.isArray(products)) return [];

    return products.map(p => {
        if (!p.url || typeof p.url !== 'string') return p;

        try {
            const urlObj = new URL(p.url);

            // Clean any existing tracking junk to keep URLs pure
            urlObj.searchParams.delete('tag');
            urlObj.searchParams.delete('ref');
            urlObj.searchParams.delete('linkCode');
            urlObj.searchParams.delete('affid');
            urlObj.searchParams.delete('affExtParam1');

            if (urlObj.hostname.includes('amazon')) {
                // RE-ENABLED: Insert Amazon Affiliate Tag!
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
            // If URL parsing fails, try basic string append dynamically for Amazon
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

/**
 * Generate clean search fallback URLs when AI doesn't have real product links
 * Temporarily outputs clean direct search links without affiliate tracking.
 */
function generateSearchFallback(product) {
    if (!product.url || 
        product.url.length < 15 || 
        product.url.includes('example.com') || 
        product.url.includes('...') || 
        product.url.includes('…') || 
        product.url === 'SEARCH') {
        
        const searchQuery = encodeURIComponent(product.title);
        if (product.platform?.toLowerCase() === 'flipkart') {
            product.url = `https://www.flipkart.com/search?q=${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'myntra') {
            product.url = `https://www.myntra.com/${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'meesho') {
            product.url = `https://www.meesho.com/search?q=${searchQuery}`;
        } else {
            // Default to Amazon (RE-ENABLED Affiliate Tracking)
            product.url = `https://www.amazon.in/s?k=${searchQuery}`;
        }
    }
    return product;
}

// ============================================================
// MAIN API HANDLER
// ============================================================
export default async function handler(req, res) {
    // CORS headers for Vercel Serverless
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { query, history = [] } = req.body;
    
    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }

    // Check cache to save API keys
    const cacheKey = typeof query === 'string' ? 'chat:' + query.toLowerCase().trim() : '';
    const cachedResponse = cacheService.get(cacheKey);
    if (cachedResponse) {
        return res.status(200).json(cachedResponse);
    }

    try {
        // Step 1: Detect shopping intent (covers ALL categories: tech, fashion, beauty, home, books, fitness)
        const isShopping = /buy|under|headphones|phone|laptop|shoes|watch|best|price|earbuds|camera|tablet|tv|speaker|keyboard|mouse|gadget|chahiye|bata|dikhao|suggest|recommend|compare|batao|dhundh|khareedo|sasta|mehenga|budget|deal|fashion|clothes|dress|shirt|kurta|saree|jeans|sneakers|beauty|skincare|cream|makeup|perfume|lipstick|serum|book|novel|fiction|home|kitchen|cooker|mattress|decor|fitness|gym|yoga|protein|dumbbell|gift|trending|top/i.test(query);
        
        let contextText = '';
        let fetchedProducts = [];
        if (isShopping) {
            fetchedProducts = await fetchGoogleShopping(query);
            if (Array.isArray(fetchedProducts) && fetchedProducts.length > 0) {
                contextText = `\n\n[Realtime Scraped Products found on Amazon/Flipkart/Myntra/Meesho]:\n${JSON.stringify(fetchedProducts)}`;
            }
        }

        // Step 2: Build message history
        const messages = history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));

        messages.push({
            role: 'user',
            content: query + contextText
        });

        // Step 3: Ask Mega Router (Groq / Gemini / Cerebras)
        const aiResult = await askMegaRouter(messages, SYSTEM_PROMPT);

        if (aiResult.error) {
            console.error("[Chat API] All AI routers failed. Engaging direct scraper fallback.");
            
            // If we didn't scrape earlier (non-shopping query), try now as last resort
            if (fetchedProducts.length === 0) {
                try {
                    fetchedProducts = await fetchGoogleShopping(query);
                } catch (e) {
                    console.error('[Chat API] Emergency scrape also failed:', e.message);
                }
            }
            
            if (fetchedProducts.length > 0) {
                // Map raw scraper results to full UI Product Cards — preserve scraper's rich data
                let finalDeals = fetchedProducts.map(r => {
                    let price = r.price || '';
                    if (!price) {
                        const priceMatch = (r.snippet || r.title || '').match(/₹[\d,]+/);
                        price = priceMatch ? priceMatch[0] : 'Check Price';
                    }

                    return {
                        title: r.title || 'Top Searched Item',
                        price: price,
                        url: r.url || '',
                        platform: r.platform || 'Store',
                        rating: r.rating || '4.5',
                        imageUrl: r.imageUrl || '',
                        description: r.description || 'Found directly via our smart search engine.',
                        pros: ['⭐ Bestseller / Top Reviewed', '🔥 Highly Searched'],
                        cons: []
                    };
                });
                
                finalDeals = injectAffiliateLinks(finalDeals);
                
                const fallbackOutput = {
                    message: "Arre bhai! AI thoda busy hai, par maine Internet ki sabse best deals tumhare liye seedhe nikaal li hain! Yeh lo Top Reviewed items 🔥",
                    products: finalDeals,
                    provider_used: "direct-scrape-fallback"
                };
                
                if (cacheKey) cacheService.set(cacheKey, fallbackOutput, 3600000);
                return res.status(200).json(fallbackOutput);
            } else {
                // Even scraping failed — return a friendly message with search links
                const searchQuery = encodeURIComponent(query);
                const emergencyProducts = [
                    {
                        title: `Search "${query}" on Amazon`,
                        price: 'Check Price',
                        url: `https://www.amazon.in/s?k=${searchQuery}&tag=${AFFILIATE_CONFIG.amazon.tag}`,
                        platform: 'Amazon',
                        rating: '4.5',
                        imageUrl: '',
                        description: 'Tap to search directly on Amazon',
                        pros: ['🛒 Direct Amazon Search'],
                        cons: []
                    },
                    {
                        title: `Search "${query}" on Flipkart`,
                        price: 'Check Price',
                        url: `https://www.flipkart.com/search?q=${searchQuery}`,
                        platform: 'Flipkart',
                        rating: '4.5',
                        imageUrl: '',
                        description: 'Tap to search directly on Flipkart',
                        pros: ['🛒 Direct Flipkart Search'],
                        cons: []
                    }
                ];
                const emergencyOutput = {
                    message: "Bhai, abhi AI aur scraper dono busy hain! Par tension mat le — yeh direct search links use kar 👇",
                    products: emergencyProducts,
                    provider_used: "emergency-search-links"
                };
                return res.status(200).json(emergencyOutput);
            }
        }

        // Step 4: Parse AI response
        let finalOutput;
        try {
            const cleanJson = aiResult.response.replace(/```json|```/g, '').trim();
            finalOutput = JSON.parse(cleanJson);
            
            // Step 5: AFFILIATE ENGINE 💰
            // This is the MONEY-MAKING step!
            if (finalOutput.products && Array.isArray(finalOutput.products)) {
                // First: Fix any fake/missing URLs with search fallbacks
                finalOutput.products = finalOutput.products.map(generateSearchFallback);
                // Then: Inject affiliate tags into ALL URLs
                finalOutput.products = injectAffiliateLinks(finalOutput.products);
                
                console.log(`[Affiliate] Injected tags into ${finalOutput.products.length} products`);
            }
            
            finalOutput.provider_used = aiResult.provider;

        } catch (parseError) {
            console.error("[Parse] AI returned invalid JSON:", aiResult.response?.substring(0, 200));
            finalOutput = {
                message: aiResult.response,
                products: [],
                provider_used: aiResult.provider,
                warning: "AI response was not JSON"
            };
        }

        // Cache successful response
        if (cacheKey) {
            cacheService.set(cacheKey, finalOutput, 3600000); // 1 hour TTL
        }

        return res.status(200).json(finalOutput);

    } catch (e) {
        console.error('[API] Error:', e);
        // Last resort: try scraping even in catch block
        try {
            const emergencyResults = await fetchGoogleShopping(query);
            if (emergencyResults && emergencyResults.length > 0) {
                let emergencyDeals = emergencyResults.map(r => {
                    let price = r.price || '';
                    if (!price) {
                        const priceMatch = (r.snippet || r.title || '').match(/₹[\d,]+/);
                        price = priceMatch ? priceMatch[0] : 'Check Price';
                    }
                    return {
                        title: r.title || 'Product',
                        price: price,
                        url: r.url || '',
                        platform: r.platform || 'Store',
                        rating: r.rating || '4.0',
                        imageUrl: r.imageUrl || '',
                        description: r.description || 'Found via emergency search.',
                        pros: ['⭐ Top Result'], cons: []
                    };
                });
                emergencyDeals = injectAffiliateLinks(emergencyDeals);
                return res.status(200).json({
                    message: "Server error hua tha, par yeh lo kuch results mil gaye! 🔥",
                    products: emergencyDeals,
                    provider_used: "emergency-fallback"
                });
            }
        } catch (e2) {
            console.error('[API] Emergency scrape also failed:', e2.message);
        }
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
