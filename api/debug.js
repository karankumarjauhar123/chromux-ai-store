// Quick debug endpoint to test individual scrapers on Vercel
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const results = {};
    const timings = {};
    
    // Test 1: Flipkart Direct
    try {
        const t1 = Date.now();
        const flipRes = await fetch('https://www.flipkart.com/search?q=' + encodeURIComponent('earbuds'), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-IN,en;q=0.9'
            },
            signal: AbortSignal.timeout(8000)
        });
        const flipHtml = await flipRes.text();
        timings.flipkart = Date.now() - t1;
        results.flipkart = { status: flipRes.status, htmlLength: flipHtml.length, hasProducts: flipHtml.includes('_1AtVbE') || flipHtml.includes('tUxRFH') || flipHtml.includes('_4rR01T') };
    } catch (e) {
        results.flipkart = { error: e.message };
    }
    
    // Test 2: Amazon Direct
    try {
        const t2 = Date.now();
        const amzRes = await fetch('https://www.amazon.in/s?k=' + encodeURIComponent('earbuds'), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-IN,en;q=0.9'
            },
            signal: AbortSignal.timeout(8000)
        });
        const amzHtml = await amzRes.text();
        timings.amazon = Date.now() - t2;
        results.amazon = { status: amzRes.status, htmlLength: amzHtml.length, hasProducts: amzHtml.includes('s-search-result') || amzHtml.includes('s-result') };
    } catch (e) {
        results.amazon = { error: e.message };
    }
    
    // Test 3: DDG Lite
    try {
        const t3 = Date.now();
        const ddgRes = await fetch('https://lite.duckduckgo.com/lite/', {
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'q=' + encodeURIComponent('earbuds site:flipkart.com'),
            signal: AbortSignal.timeout(8000)
        });
        const ddgHtml = await ddgRes.text();
        timings.ddg = Date.now() - t3;
        results.ddg = { status: ddgRes.status, htmlLength: ddgHtml.length, hasResults: ddgHtml.includes('result-link') };
    } catch (e) {
        results.ddg = { error: e.message };
    }
    
    // Test 4: Meesho API
    try {
        const t4 = Date.now();
        const meeshoRes = await fetch('https://www.meesho.com/api/v1/products/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36'
            },
            body: JSON.stringify({ query: 'earbuds', page: 0, offset: 0 }),
            signal: AbortSignal.timeout(8000)
        });
        timings.meesho = Date.now() - t4;
        if (meeshoRes.ok) {
            const meeshoJson = await meeshoRes.json();
            results.meesho = { status: meeshoRes.status, products: meeshoJson.catalogs?.length || 0 };
        } else {
            results.meesho = { status: meeshoRes.status };
        }
    } catch (e) {
        results.meesho = { error: e.message };
    }
    
    return res.status(200).json({ results, timings, vercelRegion: process.env.VERCEL_REGION || 'unknown' });
}
