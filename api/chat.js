import { askMegaRouter } from '../lib/megaRouter.js';
import { fetchGoogleShopping } from '../lib/scraper.js';

// ============================================================
// AFFILIATE CONFIG — Change these to YOUR real affiliate IDs!
// ============================================================
const AFFILIATE_CONFIG = {
    amazon: {
        // Amazon Associates Tag — Sign up at: https://affiliate-program.amazon.in/
        tag: 'chromuxaistor-21',
        // Parameter name used by Amazon
        param: 'tag'
    },
    flipkart: {
        // Flipkart Affiliate ID — Sign up at: https://affiliate.flipkart.com/
        affid: 'chromuxapp',
        // Flipkart tracking parameter
        param: 'affid'
    }
};

const SYSTEM_PROMPT = `You are "Chromux AI Store", a funny, hyper-intelligent, bilingual (Hindi/English) personal shopping assistant built for modern Gen-Z and Millennial Indians.
Your personality: Casual, enthusiastic, uses words like "bro", "bhai", "yaar", "🔥", "sahi bata raha hu".
Goal: Help the user find the best products, compare them, and save money.

CRITICAL RULES:
1. When products are provided in the context, USE THOSE ACTUAL URLs. Do NOT make up fake URLs.
2. If the context has Amazon/Flipkart links, USE THEM EXACTLY as given.
3. If no real product links are available, create a search URL like: https://www.amazon.in/s?k=product+name or https://www.flipkart.com/search?q=product+name
4. NEVER hallucinate product URLs. Use real ones from context or search URLs.

Format your response EXACTLY as valid JSON:
{
  "message": "Arre bhai! Tera budget sorted hai. Yeh dekho top suggestions 🔥",
  "products": [
    {
      "title": "Product Title",
      "price": "₹XX,XXX",
      "url": "https://amazon.in/...",
      "platform": "Amazon",
      "rating": "4.5",
      "description": "Short snappy 1-line reason why this product is good.",
      "pros": ["Great battery life", "Premium display"],
      "cons": ["No charger in box"]
    }
  ]
}

If no products are in context, or the user is just saying "Hi", keep 'products' as an empty array [] but respond warmly in the 'message' field.`;

// In-Memory cache (survives cold starts briefly on Vercel)
const responseCache = new Map();

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
    if (!product.url || product.url.length < 10 || product.url.includes('example.com')) {
        const searchQuery = encodeURIComponent(product.title);
        if (product.platform?.toLowerCase() === 'flipkart') {
            product.url = `https://www.flipkart.com/search?q=${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'myntra') {
            product.url = `https://www.myntra.com/${searchQuery}`;
        } else if (product.platform?.toLowerCase() === 'meesho') {
            product.url = `https://www.meesho.com/search?q=${searchQuery}`;
        } else {
            // Default to Amazon (RE-ENABLED Affiliate Tracking)
            product.url = `https://www.amazon.in/s?k=${searchQuery}&${AFFILIATE_CONFIG.amazon.param}=${AFFILIATE_CONFIG.amazon.tag}`;
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
    const cacheKey = typeof query === 'string' ? query.toLowerCase().trim() : '';
    if (cacheKey && responseCache.has(cacheKey)) {
        const cached = responseCache.get(cacheKey);
        if (Date.now() - cached.time < 1000 * 60 * 60) { // 1 Hour TTL
            console.log("[Cache] Hit:", cacheKey);
            return res.status(200).json(cached.data);
        }
    }

    try {
        // Step 1: Detect shopping intent
        const isShopping = /buy|under|headphones|phone|laptop|shoes|watch|best|price|earbuds|camera|tablet|tv|speaker|keyboard|mouse|gadget|chahiye|bata|dikhao|suggest|recommend|compare|batao|dhundh|khareedo|sasta|mehenga|budget|deal/i.test(query);
        
        let contextText = '';
        if (isShopping) {
            const productsInfo = await fetchGoogleShopping(query);
            if (Array.isArray(productsInfo) && productsInfo.length > 0) {
                contextText = `\n\n[Realtime Scraped Products found on Amazon/Flipkart]:\n${JSON.stringify(productsInfo)}`;
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
            return res.status(500).json({ error: aiResult.error });
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
            responseCache.set(cacheKey, { data: finalOutput, time: Date.now() });
        }

        return res.status(200).json(finalOutput);

    } catch (e) {
        console.error('[API] Error:', e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
