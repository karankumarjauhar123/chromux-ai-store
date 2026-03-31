import { fetchGoogleShopping } from '../lib/scraper.js';
import fs from 'fs';
import path from 'path';

// Load Gemini Key from environment or local keys.json
let keys = { GEMINI_KEYS: [] };
try {
  const keysData = fs.readFileSync(path.resolve(process.cwd(), 'keys.json'), 'utf8');
  keys = JSON.parse(keysData);
} catch (e) { }

const geminiEnv = process.env.GEMINI_KEYS || process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
if (geminiEnv) {
    keys.GEMINI_KEYS = geminiEnv.split(',').map(k => k.trim());
}

// System Prompt focusing heavily on structured product identification
const SYSTEM_PROMPT = `You are Chromux AI Store, a smart shopping assistant. The user has uploaded an image of a product, and possibly some text.
Your goal is to identify the EXACT product in the image and provide a brief AI summary describing what it is and its key features.
IMPORTANT: You MUST output ONLY valid JSON matching this exact structure:
{
  "message": "AI summary of the product...",
  "products": [
    {
      "title": "Exact Search Term for Amazon", 
      "price": "$0",
      "url": "SEARCH",
      "platform": "Amazon",
      "rating": "4.5",
      "imageUrl": "https://dummy",
      "description": "Short description of this specific item",
      "pros": ["Pro 1", "Pro 2", "Pro 3"],
      "cons": ["Con 1", "Con 2"]
    }
  ]
}
For 'title', give the EXACT product name that would return good results on Amazon (e.g., 'Apple iPhone 15 Pro Max 256GB' or 'Nike Air Force 1 Sneakers').
If you cannot identify the exact brand, identify the generic product ('Black Leather Jacket for Men').
Provide up to 3 similar variations or competing products in the 'products' array.
`;

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    try {
        const { query, imageBase64 } = req.body;
        
        if (!imageBase64) {
            return res.status(400).json({ error: 'imageBase64 is required for vision API' });
        }

        const apiKey = keys.GEMINI_KEYS[0];
        if (!apiKey) {
            return res.status(500).json({ error: 'No Gemini API key available' });
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        
        const parts = [];
        if (query) {
            parts.push({ text: query });
        } else {
            parts.push({ text: "What is this product? Identify it so I can buy it online." });
        }
        
        // Add image part
        parts.push({
            inline_data: {
                mime_type: "image/jpeg",
                data: imageBase64
            }
        });
        
        const contents = [{ role: "user", parts: parts }];

        const body = {
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: contents
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini Vision API Error: ${err}`);
        }

        const data = await response.json();
        let aiRaw = data.candidates[0].content.parts[0].text;
        
        // Clean JSON formatting if Gemini wraps it in markdown
        aiRaw = aiRaw.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsedJson = JSON.parse(aiRaw);
        
        // Enrich with live Amazon/Flipkart links using scraper
        // IMPORTANT: Scraper returns {title, url, snippet} — NOT {price, imageUrl, rating}
        // So we keep AI-generated price/description as fallback and only update URL + title
        if (parsedJson.products && parsedJson.products.length > 0) {
            console.log(`[Vision API] Identified ${parsedJson.products.length} products. Running scraper...`);
            
            const origProducts = parsedJson.products.slice(0, 3);
            const results = new Array(origProducts.length).fill(null);
            
            const scrapeTasks = origProducts.map(async (prod, idx) => {
                if (prod.title) {
                    try {
                        const scraped = await fetchGoogleShopping(prod.title);
                        if (scraped && scraped.length > 0) {
                            const match = scraped[0];
                            // Extract price from snippet if available
                            const priceMatch = (match.snippet || '').match(/₹[\d,]+/);
                            results[idx] = {
                                ...prod, // Keep AI-generated pros, cons, description, imageUrl
                                title: match.title || prod.title,
                                url: match.url || prod.url,
                                price: priceMatch ? priceMatch[0] : prod.price,
                                platform: match.url?.includes('flipkart') ? 'Flipkart' : 'Amazon'
                            };
                        } else {
                            results[idx] = prod;
                        }
                    } catch (e) {
                        results[idx] = prod;
                    }
                }
            });
            
            await Promise.allSettled(scrapeTasks);
            parsedJson.products = results.filter(r => r !== null);
        }

        res.status(200).json(parsedJson);

    } catch (e) {
        console.error("[Vision API] Error:", e);
        res.status(500).json({ 
            message: "I couldn't analyze the image right now. Error: " + e.message, 
            products: []
        });
    }
}
