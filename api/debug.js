// Test which free product APIs work from Vercel US servers
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const results = {};
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    
    // Test 1: Flipkart via 1mg-style API (affiliate API endpoint)
    try {
        const t = Date.now();
        const r = await fetch('https://flipkart.dvishal485.workers.dev/search/earbuds', {
            signal: AbortSignal.timeout(10000)
        });
        const data = await r.json();
        results.flipkartAPI = { time: Date.now()-t, status: r.status, products: Array.isArray(data?.result) ? data.result.length : 0, sample: data?.result?.[0]?.name?.substring(0,50) };
    } catch (e) { results.flipkartAPI = { error: e.message }; }
    
    // Test 2: PriceTracker/PriceBefore
    try {
        const t = Date.now();
        const r = await fetch('https://pricebefore.com/search/?q=earbuds', {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' },
            signal: AbortSignal.timeout(10000)
        });
        const html = await r.text();
        results.pricebefore = { time: Date.now()-t, status: r.status, bytes: html.length, hasData: html.includes('product') };
    } catch (e) { results.pricebefore = { error: e.message }; }
    
    // Test 3: Amazon via Rainforest-style endpoint
    try {
        const t = Date.now();
        const r = await fetch('https://www.amazon.in/s/ref=nb_sb_noss?field-keywords=earbuds', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html',
                'Accept-Language': 'en-IN'
            },
            signal: AbortSignal.timeout(10000)
        });
        const html = await r.text();
        results.amazonMobile = { time: Date.now()-t, status: r.status, bytes: html.length, hasProducts: html.includes('s-search-result') || html.includes('sg-col-inner') };
    } catch (e) { results.amazonMobile = { error: e.message }; }
    
    // Test 4: Google Shopping via SerpAPI-like scrape
    try {
        const t = Date.now();
        const r = await fetch('https://www.google.com/search?q=earbuds+price+india&gl=in&hl=en', {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' },
            signal: AbortSignal.timeout(10000)
        });
        const html = await r.text();
        results.googleSearch = { time: Date.now()-t, status: r.status, bytes: html.length, hasShoppingBlock: html.includes('commercial') || html.includes('shopping') || html.includes('₹') };
    } catch (e) { results.googleSearch = { error: e.message }; }
    
    // Test 5: Flipkart direct with Mobile UA
    try {
        const t = Date.now();
        const r = await fetch('https://www.flipkart.com/search?q=earbuds&marketplace=FLIPKART', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html',
                'Accept-Language': 'en-IN,en;q=0.9'
            },
            signal: AbortSignal.timeout(12000)
        });
        const html = await r.text();
        results.flipkartMobile = { time: Date.now()-t, status: r.status, bytes: html.length, hasProducts: html.includes('data-id') || html.includes('product') };
    } catch (e) { results.flipkartMobile = { error: e.message }; }
    
    return res.status(200).json({ region: process.env.VERCEL_REGION || 'unknown', results });
}
