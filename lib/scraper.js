import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchGoogleShopping(query) {
    try {
        console.log('[Scraper] Fetching 50% Amazon, 50% Others...');
        
        // Run both scrapers in parallel
        const [amazonItems, ddgItems] = await Promise.all([
            fetchAmazonDirect(query),
            fetchDuckDuckGoLite(query)
        ]);

        // Filter DDG items to NOT include Amazon (since we already have high-quality Amazon items)
        let otherItems = ddgItems.filter(item => !item.url.includes('amazon'));
        
        // Map logos to the ones without images
        otherItems = otherItems.map(item => {
            if (item.url.includes('flipkart')) {
                item.platform = 'Flipkart';
                item.imageUrl = 'https://logos-world.net/wp-content/uploads/2020/11/Flipkart-Emblem.png';
            } else if (item.url.includes('myntra')) {
                item.platform = 'Myntra';
                item.imageUrl = 'https://constant.myntassets.com/web/assets/img/icon.5810b1fdeb.png';
            } else if (item.url.includes('meesho')) {
                item.platform = 'Meesho';
                item.imageUrl = 'https://m.media-amazon.com/images/I/41KxrR2e-fL.png';
            }
            return item;
        });

        // Limit both lists to get roughly 50-50 ratio if both have enough items
        const targetHalf = 6;
        const finalAmazon = amazonItems.slice(0, targetHalf);
        const finalOthers = otherItems.slice(0, targetHalf);
        
        // Merge them alternating (A, B, A, B)
        const combined = [];
        const maxLen = Math.max(finalAmazon.length, finalOthers.length);
        for (let i = 0; i < maxLen; i++) {
            if (finalAmazon[i]) combined.push(finalAmazon[i]);
            if (finalOthers[i]) combined.push(finalOthers[i]);
        }

        if (combined.length === 0) return amazonItems;

        console.log(`[Scraper] Merged Results: ${finalAmazon.length} Amazon, ${finalOthers.length} Others`);
        return combined;

    } catch (e) {
        console.error('[Scraper] Top-level error:', e.message);
        return [];
    }
}

export async function fetchAmazonDirect(query) {
    try {
        const searchQuery = encodeURIComponent(query);
        const url = `https://www.amazon.in/s?k=${searchQuery}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;'
            }
        });

        if (!res.ok) {
            console.error(`[Scraper] Amazon returned status ${res.status}`);
            return await fetchDuckDuckGoLite(query);
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        const results = [];

        $('div[data-component-type="s-search-result"]').each((i, el) => {
            if (i >= 20) return false;

            const title = $(el).find('h2 a span').text().trim();
            const href = $(el).find('h2 a').attr('href') || '';
            const fullUrl = href.startsWith('/') ? `https://www.amazon.in${href}` : href;

            const priceEl = $(el).find('.a-price-whole').first();
            let price = priceEl.text().trim();
            if (price) price = '₹' + price;

            const imageUrl = $(el).find('.s-image').attr('src') || '';
            
            let rating = $(el).find('i[class*="a-icon-star"] span').text().trim();
            if (rating) rating = rating.split(' ')[0];

            if (title && href && price && imageUrl) {
                results.push({
                    title,
                    url: fullUrl,
                    price: price,
                    imageUrl: imageUrl,
                    platform: 'Amazon',
                    rating: rating || '4.0',
                    snippet: 'Top rated product'
                });
            }
        });

        console.log(`[Scraper] Found ${results.length} products from Amazon with Images`);
        
        if (results.length === 0) {
           console.log(`[Scraper] Amazon returned 0 results. Falling back to DuckDuckGo Lite...`);
           return await fetchDuckDuckGoLite(query); 
        }

        return results;
    } catch (e) {
        console.error('[Scraper] Amazon error:', e.message);
        return await fetchDuckDuckGoLite(query); 
    }
}

export async function fetchDuckDuckGoLite(query) {
    try {
        const searchQuery = encodeURIComponent(`site:flipkart.com OR site:myntra.com OR site:meesho.com ${query}`);
        const url = `https://lite.duckduckgo.com/lite/`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
            },
            body: `q=${searchQuery}`
        });

        if (!res.ok) {
            console.error(`[Scraper] DuckDuckGo returned status ${res.status}`);
            return [];
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        const results = [];

        // DuckDuckGo Lite uses a table-based layout
        // Results are in <tr> elements, with links in <a class="result-link"> 
        // and snippets in <td class="result-snippet">
        $('a.result-link').each((i, el) => {
            if (i >= 8) return false; // Limit to 8 results
            const title = $(el).text().trim();
            const href = $(el).attr('href') || '';

            // Find the next sibling snippet row
            const snippetRow = $(el).closest('tr').next('tr');
            const snippet = snippetRow.find('td.result-snippet').text().trim();

            if (title && href && (href.includes('amazon.in') || href.includes('flipkart.com') || href.includes('myntra.com') || href.includes('meesho.com'))) {
                results.push({ title, url: href, snippet });
            }
        });

        // Fallback: try alternative selectors if result-link didn't match
        if (results.length === 0) {
            $('a[href]').each((i, el) => {
                if (results.length >= 5) return false;
                const href = $(el).attr('href') || '';
                const title = $(el).text().trim();
                
                if (title.length > 10 && (href.includes('amazon.in') || href.includes('flipkart.com') || href.includes('myntra.com') || href.includes('meesho.com'))) {
                    // Skip DuckDuckGo's own links
                    if (!href.includes('duckduckgo.com')) {
                        results.push({ title, url: href, snippet: '' });
                    }
                }
            });
        }

        console.log(`[Scraper] Found ${results.length} product links from DuckDuckGo`);
        return results;
    } catch (e) {
        console.error('[Scraper] DuckDuckGo error:', e.message);
        return [];
    }
}
