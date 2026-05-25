import * as cheerio from 'cheerio';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
];

function getUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * BACKWARDS-COMPATIBLE: Returns a flat array of products (used by chat.js, vision.js, check-price.js)
 */
export async function fetchGoogleShopping(query) {
    const grouped = await fetchGoogleShoppingGrouped(query);
    return [
        ...grouped.amazon,
        ...grouped.flipkart,
        ...grouped.myntra,
        ...grouped.meesho
    ];
}

/**
 * NEW: Returns grouped results by platform (used by search.js, trending.js)
 */
export async function fetchGoogleShoppingGrouped(query) {
    try {
        console.log(`[Scraper] Fetching cross-platform deep search for: ${query}`);
        
        // Fire ALL sources in parallel:
        // 1. Direct platform scrapers (4 parallel)
        // 2. Google Shopping Tab (1 request, all platforms)
        const results = await Promise.allSettled([
            fetchWithFallback('amazon', query),
            fetchWithFallback('flipkart', query),
            fetchWithFallback('myntra', query),
            fetchWithFallback('meesho', query),
            fetchGoogleShoppingTab(query)  // Backup: gets ALL platforms at once
        ]);

        let amazonItems = results[0].status === 'fulfilled' ? results[0].value : [];
        let flipkartItems = results[1].status === 'fulfilled' ? results[1].value : [];
        let myntraItems = results[2].status === 'fulfilled' ? results[2].value : [];
        let meeshoItems = results[3].status === 'fulfilled' ? results[3].value : [];
        const googleShoppingItems = results[4].status === 'fulfilled' ? results[4].value : { amazon: [], flipkart: [], myntra: [], meesho: [], other: [] };

        // 🔥 KEY FIX: If any direct scraper returned 0, fill from Google Shopping
        if (amazonItems.length === 0 && googleShoppingItems.amazon.length > 0) {
            amazonItems = googleShoppingItems.amazon;
            console.log(`[Scraper] Amazon: Direct failed → Google Shopping filled ${amazonItems.length} items`);
        }
        if (flipkartItems.length === 0 && googleShoppingItems.flipkart.length > 0) {
            flipkartItems = googleShoppingItems.flipkart;
            console.log(`[Scraper] Flipkart: Direct failed → Google Shopping filled ${flipkartItems.length} items`);
        }
        if (myntraItems.length === 0 && googleShoppingItems.myntra.length > 0) {
            myntraItems = googleShoppingItems.myntra;
            console.log(`[Scraper] Myntra: Direct failed → Google Shopping filled ${myntraItems.length} items`);
        }
        if (meeshoItems.length === 0 && googleShoppingItems.meesho.length > 0) {
            meeshoItems = googleShoppingItems.meesho;
            console.log(`[Scraper] Meesho: Direct failed → Google Shopping filled ${meeshoItems.length} items`);
        }

        // Also merge "other" platform items into the least-populated platform
        if (googleShoppingItems.other && googleShoppingItems.other.length > 0) {
            // Add uncategorized Google Shopping products to whichever platform has least items
            const counts = [
                { name: 'amazon', items: amazonItems },
                { name: 'flipkart', items: flipkartItems },
                { name: 'myntra', items: myntraItems },
                { name: 'meesho', items: meeshoItems }
            ].sort((a, b) => a.items.length - b.items.length);

            // Distribute "other" items to platforms with fewer results
            for (const item of googleShoppingItems.other) {
                counts[0].items.push(item);
            }
        }

        // Map Fallback Images where missing
        const processItems = (items, platformName, logoUrl) => {
            return items.map(item => {
                item.platform = platformName;
                if (!item.imageUrl || item.imageUrl.length < 10) {
                    // Generate product-relevant image from title keywords
                    const title = (item.title || '').toLowerCase();
                    let keyword = 'product';
                    
                    // Map common product types to image keywords
                    if (/earbuds|headphone|airpod|airdope|tws|earphone/.test(title)) keyword = 'earbuds+wireless';
                    else if (/phone|mobile|smartphone|iphone|samsung|redmi|realme|poco/.test(title)) keyword = 'smartphone';
                    else if (/laptop|notebook|macbook|chromebook/.test(title)) keyword = 'laptop+computer';
                    else if (/watch|smartwatch|band|fitbit/.test(title)) keyword = 'smartwatch';
                    else if (/tv|television|monitor|display/.test(title)) keyword = 'television+screen';
                    else if (/camera|dslr|gopro/.test(title)) keyword = 'camera';
                    else if (/shoe|sneaker|sandal|slipper/.test(title)) keyword = 'shoes+sneakers';
                    else if (/shirt|kurta|dress|saree|jeans|jacket/.test(title)) keyword = 'clothing+fashion';
                    else if (/cream|serum|lipstick|makeup|beauty|skin/.test(title)) keyword = 'beauty+cosmetics';
                    else if (/bag|backpack|purse|wallet/.test(title)) keyword = 'bag+backpack';
                    else if (/speaker|soundbar|bluetooth/.test(title)) keyword = 'bluetooth+speaker';
                    else if (/keyboard|mouse|gaming/.test(title)) keyword = 'gaming+keyboard';
                    else if (/tablet|ipad/.test(title)) keyword = 'tablet+device';
                    else if (/charger|power|bank|cable/.test(title)) keyword = 'charger+powerbank';
                    else if (/book|novel/.test(title)) keyword = 'book';
                    
                    // Use unique seed from title hash for variety
                    const hash = Math.abs(title.split('').reduce((a, c) => ((a << 5) - a) + c.charCodeAt(0), 0));
                    item.imageUrl = `https://source.unsplash.com/400x400/?${keyword}&sig=${hash}`;
                }
                
                // Parse Price numeric
                let priceRaw = item.price || '';
                let priceMatches = priceRaw.match(/[\d,]+/);
                item.priceNumeric = priceMatches ? parseInt(priceMatches[0].replace(/,/g, ''), 10) : 0;
                
                // Ensure default Rating
                if (!item.rating) item.rating = '4.0';
                item.ratingNumeric = parseFloat(item.rating) || 4.0;
                
                return item;
            });
        };

        const finalAmazon = processItems(amazonItems, 'Amazon', 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg');
        const finalFlipkart = processItems(flipkartItems, 'Flipkart', 'https://logos-world.net/wp-content/uploads/2020/11/Flipkart-Emblem.png');
        const finalMyntra = processItems(myntraItems, 'Myntra', 'https://constant.myntassets.com/web/assets/img/icon.5810b1fdeb.png');
        const finalMeesho = processItems(meeshoItems, 'Meesho', 'https://play-lh.googleusercontent.com/1G60_p-yL3E3M4V2fN1n0M6J4v3OqU9kXl-YnBNyX8qQpWvwgH_0nJ1LzG-fA4HqP1g');

        console.log(`[Scraper] FINAL: ${finalAmazon.length} Amz, ${finalFlipkart.length} Fpk, ${finalMyntra.length} Myn, ${finalMeesho.length} Msh`);

        return {
            amazon: finalAmazon,
            flipkart: finalFlipkart,
            myntra: finalMyntra,
            meesho: finalMeesho
        };

    } catch (e) {
        console.error('[Scraper] Top-level error:', e.message);
        return { amazon: [], flipkart: [], myntra: [], meesho: [] };
    }
}

// ============================================================
// 3-LAYER PARALLEL RACE: PriceBefore + Direct + DDG (100% Free)
// PriceBefore = primary (works from US/global Vercel servers!)
// Direct = backup (works from Indian servers/local)
// ============================================================

async function fetchWithFallback(platform, query) {
    const siteMap = { amazon: 'amazon.in', flipkart: 'flipkart.com', myntra: 'myntra.com', meesho: 'meesho.com' };
    const site = siteMap[platform] || `${platform}.com`;
    
    // Get the direct scraper function for this platform
    let directFn;
    if (platform === 'amazon') directFn = fetchAmazonDirect;
    else if (platform === 'flipkart') directFn = fetchFlipkartDirect;
    else if (platform === 'myntra') directFn = fetchMyntraDirect;
    else if (platform === 'meesho') directFn = fetchMeeshoDirect;
    
    // 🔥 FIRE ALL 3 LAYERS AT ONCE — first valid result wins!
    const allPromises = [
        // Layer 1: PriceBefore (PRIORITY — works from US Vercel servers!)
        fetchPriceBefore(query, platform).catch(() => []),
        // Layer 2: Direct scraper (backup — works from Indian servers)
        directFn ? directFn(query).catch(() => []) : Promise.resolve([]),
        // Layer 3: DDG Lite (last resort)
        fetchDuckDuckGoLite(query, site).catch(() => [])
    ];
    
    // Race: return as soon as ANY layer has valid results
    // PriceBefore (Layer 1) gets priority — resolves immediately
    // Direct (Layer 2) resolves after 200ms delay to prefer PriceBefore
    try {
        const result = await new Promise((resolve) => {
            let resolved = false;
            const layers = ['PriceBefore', 'Direct', 'DDG'];
            
            // Set overall timeout — give up after 15s
            const timeout = setTimeout(() => {
                if (!resolved) { resolved = true; resolve([]); }
            }, 15000);
            
            allPromises.forEach((promise, i) => {
                promise.then(items => {
                    if (!resolved && items && items.length > 0) {
                        // Layer 1 (PriceBefore) resolves immediately
                        // Layer 2/3 resolve after a delay to prefer PriceBefore
                        const delay = (i === 0) ? 0 : 300;
                        setTimeout(() => {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                console.log(`[Scraper] ${platform} Layer ${i+1} (${layers[i]}) returned ${items.length} items`);
                                resolve(items);
                            }
                        }, delay);
                    }
                });
            });
            
            // If all complete with 0 results, resolve empty
            Promise.allSettled(allPromises).then(() => {
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        resolve([]);
                    }
                }, 400);
            });
        });
        
        if (result.length > 0) return result;
    } catch (e) {
        console.log(`[Scraper] ${platform} race error: ${e.message}`);
    }

    console.log(`[Scraper] ${platform} ALL layers exhausted. 0 items.`);
    return [];
}

// ============================================================
// LAYER 1: DIRECT SCRAPERS (Fixed April 2026)
// ============================================================

async function fetchAmazonDirect(query) {
    try {
        const searchQuery = encodeURIComponent(query);
        const url = `https://www.amazon.in/s?k=${searchQuery}`;

        const res = await fetch(url, { 
            headers: { 
                'User-Agent': getUA(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8,hi;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Cache-Control': 'max-age=0',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            },
            signal: AbortSignal.timeout(12000) 
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('div[data-component-type="s-search-result"]').each((i, el) => {
            if (results.length >= 60) return false;

            // FIXED: Use img alt for title (h2 a span is now obfuscated by Amazon)
            const imgEl = $(el).find('img.s-image');
            let title = imgEl.attr('alt') || '';
            
            // Skip "More like this" recommendation cards
            if (!title || title === 'More like this' || title.length < 10) return;
            
            // Clean sponsored prefix
            title = title.replace(/^Sponsored\s*(Ad\s*)?-?\s*/i, '').trim();
            
            const imgSrc = imgEl.attr('src') || '';
            
            // Link: prefer /dp/ links 
            let href = $(el).find('a[href*="/dp/"]').first().attr('href') || 
                        $(el).find('h2 a').attr('href') || '';
            const fullUrl = href.startsWith('/') ? `https://www.amazon.in${href}` : href;

            // Price
            const priceWhole = $(el).find('span.a-price-whole').first().text().trim().replace('.', '');
            let price = priceWhole ? '₹' + priceWhole : '';

            // Original Price for Discount
            const originalPriceEl = $(el).find('.a-text-price span[aria-hidden="true"]').first();
            let originalPrice = originalPriceEl.text().trim();

            let discount = '';
            if (price && originalPrice) {
                let p1 = parseInt(price.replace(/[^\d]/g, ''), 10);
                let p2 = parseInt(originalPrice.replace(/[^\d]/g, ''), 10);
                if (p2 > p1 && p1 > 0) {
                    discount = Math.round(((p2 - p1) / p2) * 100) + '% off';
                }
            }

            // Rating from icon-alt text
            let rating = '';
            const ratingAlt = $(el).find('.a-icon-alt').first().text().trim();
            if (ratingAlt) {
                const match = ratingAlt.match(/([\d.]+)/);
                if (match) rating = match[1];
            }

            if (title && fullUrl && (price || imgSrc)) {
                results.push({
                    title, url: fullUrl, price: price || 'Check Price', 
                    imageUrl: imgSrc, rating: rating || '4.0', discount, snippet: 'Amazon'
                });
            }
        });

        return results;
    } catch (e) {
        console.error('[Amazon Direct] Error:', e.message);
        return [];
    }
}

async function fetchFlipkartDirect(query) {
    try {
        const searchQuery = encodeURIComponent(query);
        const url = `https://www.flipkart.com/search?q=${searchQuery}`;

        const res = await fetch(url, { 
            headers: { 
                'User-Agent': getUA(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8,hi;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
            },
            signal: AbortSignal.timeout(12000) 
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];
        const seenUrls = new Set();

        // FIXED: Use [data-id] product card containers instead of a[target="_blank"]
        $('[data-id]').each((i, el) => {
            if (results.length >= 50) return false;

            // Title from image alt
            const imgEl = $(el).find('img[alt]').first();
            let title = imgEl.attr('alt') || '';
            if (!title || title === 'Flipkart' || title.length < 5) return;
            
            const imageUrl = imgEl.attr('src') || '';
            if (imageUrl.includes('data:image')) return;

            // Link
            const href = $(el).find('a[href*="/p/"]').first().attr('href') || 
                          $(el).find('a').first().attr('href') || '';
            const fullUrl = href.startsWith('/') ? `https://www.flipkart.com${href}` : href;
            
            // Deduplicate
            const cleanUrl = fullUrl.split('?')[0];
            if (seenUrls.has(cleanUrl)) return;
            seenUrls.add(cleanUrl);

            // Price: find innermost div/span with ₹ text (avoid accumulated text from children)
            let price = '';
            let originalPrice = '';
            let discount = '';
            
            // Get all text nodes that contain ₹
            $(el).find('div, span').each((_, child) => {
                // Check if this element's OWN text (not children) contains ₹
                const ownText = $(child).clone().children().remove().end().text().trim();
                
                if (ownText.startsWith('₹') && ownText.length < 15) {
                    if (!price) {
                        price = ownText;
                    } else if (!originalPrice) {
                        originalPrice = ownText;
                    }
                }
                
                // Discount: match exact "XX% off" pattern
                if (ownText.match(/^\d+%\s*off$/)) {
                    discount = ownText;
                }
            });
            
            // Fallback: use accumulated text
            if (!price) {
                $(el).find('div, span').each((_, child) => {
                    const text = $(child).text().trim();
                    if (text.startsWith('₹') && text.length < 15 && !price) {
                        price = text;
                    }
                });
            }
            
            // Fallback discount calculation
            if (!discount && price && originalPrice) {
                let p1 = parseInt(price.replace(/[^\d]/g, ''), 10);
                let p2 = parseInt(originalPrice.replace(/[^\d]/g, ''), 10);
                if (p2 > p1 && p1 > 0) {
                    discount = Math.round(((p2 - p1) / p2) * 100) + '% off';
                }
            }

            // Rating: find standalone decimal like "4.3"
            let rating = '';
            $(el).find('div, span').each((_, child) => {
                const ownText = $(child).clone().children().remove().end().text().trim();
                if (ownText.match(/^[1-5]\.\d$/) && !rating) {
                    rating = ownText;
                }
            });

            if (title && price && price !== '₹') {
                results.push({
                    title, url: fullUrl, price, imageUrl, 
                    rating: rating || '4.0', discount, snippet: 'Flipkart'
                });
            }
        });

        return results;
    } catch (e) {
        console.error('[Flipkart Direct] Error:', e.message);
        return [];
    }
}

// --- Layer 1A: Myntra Direct HTML Scraper ---
async function fetchMyntraDirect(query) {
    try {
        // Myntra uses slug-based URLs for categories
        const slug = query.toLowerCase().replace(/\s+/g, '-');
        const url = `https://www.myntra.com/${encodeURIComponent(slug)}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': getUA(),
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
            },
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return [];

        const html = await res.text();
        const results = [];

        // Strategy A: Extract from window.__myx (embedded JSON)
        const myxMatch = html.match(/window\.__myx\s*=\s*({.+?});/s);
        if (myxMatch) {
            try {
                const data = JSON.parse(myxMatch[1]);
                const products = data?.searchData?.results?.products || [];
                for (const p of products.slice(0, 40)) {
                    const imgSrc = p.images && p.images.length > 0 ? p.images[0].src : '';
                    results.push({
                        title: `${p.brand || ''} ${p.product || ''}`.trim(),
                        price: `₹${p.price || p.mrp || 0}`,
                        imageUrl: imgSrc ? `https://assets.myntassets.com/${imgSrc}` : '',
                        url: `https://www.myntra.com/${p.landingPageUrl || ''}`,
                        rating: (p.rating?.average || 4.0).toString(),
                        discount: p.discount ? `${p.discount}% off` : ''
                    });
                }
                if (results.length > 0) return results;
            } catch (jsonErr) {
                console.log('[Myntra Direct] __myx JSON parse failed, trying cheerio...');
            }
        }

        // Strategy B: Cheerio fallback (parse SSR HTML)
        const $ = cheerio.load(html);
        $('.product-base').each((i, el) => {
            if (i >= 40) return false;
            const brand = $(el).find('.product-brand').text().trim();
            const product = $(el).find('.product-product').text().trim();
            const discountedPrice = $(el).find('.product-discountedPrice').text().trim();
            const strikePrice = $(el).find('.product-strike').text().trim();
            const discountPct = $(el).find('.product-discountPercentage').text().trim();
            const imgUrl = $(el).find('img.img-responsive').attr('src') || $(el).find('picture source').attr('srcset') || '';
            const link = $(el).find('a').attr('href') || '';

            if (brand && (discountedPrice || strikePrice)) {
                results.push({
                    title: `${brand} ${product}`,
                    price: discountedPrice || strikePrice,
                    imageUrl: imgUrl,
                    url: link.startsWith('http') ? link : `https://www.myntra.com${link}`,
                    rating: '4.0',
                    discount: discountPct.replace(/[()]/g, '').trim()
                });
            }
        });

        return results;
    } catch (e) {
        console.error('[Myntra Direct] Error:', e.message);
        return [];
    }
}

// --- Layer 1B: Meesho Direct HTML Scraper (Next.js __NEXT_DATA__) ---
async function fetchMeeshoDirect(query) {
    try {
        const url = `https://www.meesho.com/search?q=${encodeURIComponent(query)}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': getUA(),
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-IN,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
            },
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return [];

        const html = await res.text();
        const results = [];

        // Strategy A: Extract __NEXT_DATA__ JSON
        const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
        if (nextMatch) {
            try {
                const nextData = JSON.parse(nextMatch[1]);
                // Meesho nests product data in various paths
                const products = nextData?.props?.pageProps?.productList ||
                                 nextData?.props?.pageProps?.initialData?.catalogList ||
                                 nextData?.props?.pageProps?.data?.catalogs || [];
                for (const p of products.slice(0, 40)) {
                    const name = p.name || p.product_name || p.title || '';
                    const price = p.min_catalog_price || p.min_product_price || p.price || 0;
                    const mrp = p.product_mrp || p.mrp || price;
                    const img = (p.images && p.images[0]?.url) || (p.product_images && p.product_images[0]) || '';
                    const slug = p.slug || p.product_id || '';
                    const discount = mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;

                    if (name && price) {
                        results.push({
                            title: name,
                            price: `₹${price}`,
                            imageUrl: img,
                            url: `https://www.meesho.com/${slug}`,
                            rating: (p.rating?.average || p.average_rating || 4.0).toString(),
                            discount: discount > 0 ? `${discount}% off` : ''
                        });
                    }
                }
                if (results.length > 0) return results;
            } catch (jsonErr) {
                console.log('[Meesho Direct] __NEXT_DATA__ parse failed');
            }
        }

        // Strategy B: Cheerio fallback (if SSR has product cards)
        const $ = cheerio.load(html);
        $('[data-testid="product-card"], .ProductCard, .sc-dkrFOg').each((i, el) => {
            if (i >= 30) return false;
            const title = $(el).find('p, h3, h4').first().text().trim();
            const priceText = $(el).find('[class*="Price"], [class*="price"]').first().text().trim();
            const link = $(el).find('a').attr('href') || '';
            const img = $(el).find('img').attr('src') || '';

            if (title && priceText) {
                results.push({
                    title, price: priceText, imageUrl: img,
                    url: link.startsWith('http') ? link : `https://www.meesho.com${link}`,
                    rating: '4.0', discount: ''
                });
            }
        });

        return results;
    } catch (e) {
        console.error('[Meesho Direct] Error:', e.message);
        return [];
    }
}

// --- Layer 1: PriceBefore.com Aggregator (FREE, Fast, Static HTML) ---
// WORKS FROM US VERCEL SERVERS! This is our primary scraper.
async function fetchPriceBefore(query, platformHint = '') {
    try {
        const searchQuery = platformHint 
            ? `${query} ${platformHint}` 
            : query;
        const url = `https://pricebefore.com/search/?q=${encodeURIComponent(searchQuery)}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': getUA(),
                'Accept': 'text/html',
                'Accept-Language': 'en-IN,en;q=0.9',
            },
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        // PriceBefore structure: div.unit > div.txt-wrap > div.title > h2 > a.link
        $('div.unit').each((i, el) => {
            if (results.length >= 40) return false;

            // Title from a.link inside h2
            const titleLink = $(el).find('a.link').first();
            const title = titleLink.attr('title') || titleLink.text().trim();
            const pbHref = titleLink.attr('href') || '';
            
            if (!title || title.length < 5) return;

            // Price from div.final
            const priceText = $(el).find('div.final').text().trim();
            const priceMatch = priceText.match(/Rs\.?\s?([\d,]+(?:\.\d{2})?)/);
            if (!priceMatch) return;
            
            const price = `₹${priceMatch[1].replace(/\.00$/, '')}`;

            // Discount from span.percent
            const discountText = $(el).find('span.percent').text().trim();
            const discountMatch = discountText.match(/(\d+)%/);
            const discount = discountMatch ? `${discountMatch[1]}% off` : '';

            // Generate real platform search URL for affiliate linking
            const cleanTitle = title.replace(/\.\.\.$/g, '').trim();
            const searchTerm = encodeURIComponent(cleanTitle.substring(0, 60));
            let platformUrl = '';
            const hint = platformHint.toLowerCase();
            
            if (hint.includes('amazon') || cleanTitle.toLowerCase().includes('amazon')) {
                platformUrl = `https://www.amazon.in/s?k=${searchTerm}`;
            } else if (hint.includes('flipkart') || cleanTitle.toLowerCase().includes('flipkart')) {
                platformUrl = `https://www.flipkart.com/search?q=${searchTerm}`;
            } else if (hint.includes('myntra') || cleanTitle.toLowerCase().includes('myntra')) {
                platformUrl = `https://www.myntra.com/${searchTerm}`;
            } else if (hint.includes('meesho') || cleanTitle.toLowerCase().includes('meesho')) {
                platformUrl = `https://www.meesho.com/search?q=${searchTerm}`;
            } else {
                // Default: link to pricebefore product page (will be wrapped by affiliate)
                platformUrl = pbHref.startsWith('/') ? `https://pricebefore.com${pbHref}` : pbHref;
            }

            // Rating from text (if available)
            const fullText = $(el).text();
            const ratingMatch = fullText.match(/([1-5]\.?\d?)\s*(?:out of|\/)\s*5/);
            const rating = ratingMatch ? ratingMatch[1] : '4.0';

            // 🖼️ Extract REAL product image from div.unit
            const imgEl = $(el).find('img').first();
            const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';

            results.push({
                title: cleanTitle,
                price,
                url: platformUrl || `https://pricebefore.com${pbHref}`,
                imageUrl: imageUrl, // Real product image from PriceBefore!
                rating,
                discount,
                snippet: 'PriceBefore'
            });
        });

        console.log(`[PriceBefore] Found ${results.length} items for "${searchQuery}"`);
        return results;
    } catch (e) {
        console.error('[PriceBefore] Error:', e.message);
        return [];
    }
}

// --- Layer 3: DuckDuckGo Lite (Last Resort Fallback) ---
async function fetchDuckDuckGoLite(query, siteTarget) {
    try {
        const searchQuery = encodeURIComponent(`site:${siteTarget} ${query}`);
        const url = `https://lite.duckduckgo.com/lite/`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': getUA(),
            },
            body: `q=${searchQuery}`,
            signal: AbortSignal.timeout(10000)
        });

        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('a.result-link').each((i, el) => {
            if (results.length >= 30) return false;
            
            let title = $(el).text().trim();
            const href = $(el).attr('href') || '';
            const snippetRow = $(el).closest('tr').next('tr');
            const snippet = snippetRow.find('td.result-snippet').text().trim();

            // Skip ads and non-platform links
            if (!href.includes(siteTarget.replace('.com', ''))) return;
            if (href.includes('duckduckgo.com')) return;

            // Extract price from title or snippet (e.g. "Buy xyz for Rs. 499..." or "₹499")
            let priceMatch = title.match(/(?:Rs\.?|₹|INR)\s?([\d,]+)/i) || snippet.match(/(?:Rs\.?|₹|INR)\s?([\d,]+)/i);
            let price = priceMatch ? '₹' + priceMatch[1] : '';
            
            // Clean title
            title = title.replace(/Buy|Online|at Best Prices|in India|from Myntra|Flipkart|Meesho|Amazon/gi, '').replace(/-|\|.*/g, '').trim();

            let discountMatch = title.match(/\d+% off/i) || snippet.match(/\d+% off/i);
            let discount = discountMatch ? discountMatch[0] : '';

            // Accept items even without price — better to show something than nothing
            if (title && title.length > 5) {
                results.push({ 
                    title, url: href, price: price || 'Check Price', 
                    snippet, imageUrl: '', rating: '4.0', discount 
                });
            }
        });

        return results;
    } catch (e) {
        console.error('[DDG Lite] Error:', e.message);
        return [];
    }
}

// ============================================================
// GOOGLE SHOPPING TAB SCRAPER
// One request → products from ALL Indian e-commerce platforms!
// This is the BACKUP that ensures we ALWAYS have multi-platform results.
// ============================================================

/**
 * Detect which Indian e-commerce platform a product belongs to
 * based on merchant name, URL, or source text
 */
function detectPlatformFromMerchant(merchantName, url, text) {
    const combined = `${merchantName} ${url} ${text}`.toLowerCase();
    
    if (combined.includes('amazon')) return 'amazon';
    if (combined.includes('flipkart')) return 'flipkart';
    if (combined.includes('myntra')) return 'myntra';
    if (combined.includes('meesho')) return 'meesho';
    if (combined.includes('ajio')) return 'flipkart';  // Ajio → Flipkart group
    if (combined.includes('nykaa')) return 'myntra';    // Nykaa → Myntra (fashion) group
    if (combined.includes('tata cliq') || combined.includes('tatacliq')) return 'flipkart';
    if (combined.includes('snapdeal')) return 'meesho'; // Budget platform → Meesho group
    if (combined.includes('jiomart')) return 'flipkart';
    if (combined.includes('croma')) return 'amazon';    // Electronics → Amazon group
    if (combined.includes('reliance')) return 'flipkart';
    
    return 'other';
}

async function fetchGoogleShoppingTab(query) {
    const grouped = { amazon: [], flipkart: [], myntra: [], meesho: [], other: [] };
    
    try {
        console.log(`[Multi-Platform Backup] Firing parallel DDG searches for all platforms...`);
        
        // Fire 4 parallel DDG Lite searches — one per platform
        const sites = [
            { key: 'amazon', site: 'amazon.in' },
            { key: 'flipkart', site: 'flipkart.com' },
            { key: 'myntra', site: 'myntra.com' },
            { key: 'meesho', site: 'meesho.com' }
        ];
        
        const results = await Promise.allSettled(
            sites.map(s => fetchDuckDuckGoLite(query, s.site))
        );
        
        for (let i = 0; i < sites.length; i++) {
            if (results[i].status === 'fulfilled' && results[i].value.length > 0) {
                grouped[sites[i].key] = results[i].value;
            }
        }
        
        console.log(`[Multi-Platform Backup] Found: ${grouped.amazon.length} Amz, ${grouped.flipkart.length} Fpk, ${grouped.myntra.length} Myn, ${grouped.meesho.length} Msh`);
        return grouped;
        
    } catch (e) {
        console.error('[Multi-Platform Backup] Error:', e.message);
        return grouped;
    }
}

