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
        
        // Deep Parallel Scrape with 3-layer waterfall for each platform
        const results = await Promise.allSettled([
            fetchWithFallback('amazon', query),
            fetchWithFallback('flipkart', query),
            fetchWithFallback('myntra', query),
            fetchWithFallback('meesho', query)
        ]);

        const amazonItems = results[0].status === 'fulfilled' ? results[0].value : [];
        const flipkartItems = results[1].status === 'fulfilled' ? results[1].value : [];
        const myntraItems = results[2].status === 'fulfilled' ? results[2].value : [];
        const meeshoItems = results[3].status === 'fulfilled' ? results[3].value : [];

        // Map Fallback Images where missing
        const processItems = (items, platformName, logoUrl) => {
            return items.map(item => {
                item.platform = platformName;
                if (!item.imageUrl || item.imageUrl.length < 5) {
                    item.imageUrl = logoUrl;
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

        console.log(`[Scraper] Aggregated: ${finalAmazon.length} Amz, ${finalFlipkart.length} Fpk, ${finalMyntra.length} Myn, ${finalMeesho.length} Msh`);

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
// 3-LAYER WATERFALL: Direct → PriceBefore → DDG (100% Free)
// ============================================================

async function fetchWithFallback(platform, query) {
    // Layer 1: Direct site scraper (fastest)
    let results = [];
    try {
        if (platform === 'amazon') {
            results = await fetchAmazonDirect(query);
        } else if (platform === 'flipkart') {
            results = await fetchFlipkartDirect(query);
        } else if (platform === 'myntra') {
            results = await fetchMyntraDirect(query);
        } else if (platform === 'meesho') {
            results = await fetchMeeshoDirect(query);
        }
        if (results.length > 0) {
            console.log(`[Scraper] ${platform} Layer 1 (Direct) returned ${results.length} items`);
            return results;
        }
    } catch (e) {
        console.log(`[Scraper] ${platform} Layer 1 (Direct) failed: ${e.message}`);
    }

    // Layer 2: PriceBefore.com aggregator
    try {
        results = await fetchPriceBefore(query, platform);
        if (results.length > 0) {
            console.log(`[Scraper] ${platform} Layer 2 (PriceBefore) returned ${results.length} items`);
            return results;
        }
    } catch (e) {
        console.log(`[Scraper] ${platform} Layer 2 (PriceBefore) failed: ${e.message}`);
    }

    // Layer 3: DDG Lite (slowest but most reliable)
    console.log(`[Scraper] ${platform} falling to Layer 3 (DDG Lite)...`);
    try {
        results = await fetchDuckDuckGoLite(query, `${platform}.com`);
        if (results.length > 0) {
            console.log(`[Scraper] ${platform} Layer 3 (DDG) returned ${results.length} items`);
            return results;
        }
    } catch (e) {
        console.log(`[Scraper] ${platform} Layer 3 (DDG) failed: ${e.message}`);
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
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
            },
            signal: AbortSignal.timeout(8000) 
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('div[data-component-type="s-search-result"]').each((i, el) => {
            if (results.length >= 40) return false;

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
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-IN,en;q=0.9',
            },
            signal: AbortSignal.timeout(8000) 
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];
        const seenUrls = new Set();

        // FIXED: Use [data-id] product card containers instead of a[target="_blank"]
        $('[data-id]').each((i, el) => {
            if (results.length >= 30) return false;

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
            },
            signal: AbortSignal.timeout(6000)
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
                for (const p of products.slice(0, 30)) {
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
            if (i >= 30) return false;
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
            },
            signal: AbortSignal.timeout(6000)
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
                for (const p of products.slice(0, 30)) {
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
            if (i >= 20) return false;
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

// --- Layer 2: PriceBefore.com Aggregator (FREE, Fast, Static HTML) ---
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
            },
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        // PriceBefore uses list items with product links
        $('li').each((i, el) => {
            if (results.length >= 20) return false;

            const linkEl = $(el).find('a[href*="pricebefore.com/"]').first();
            const link = linkEl.attr('href') || '';
            const titleEl = $(el).find('a[href*="pricebefore.com/"]').last();
            const title = titleEl.text().trim();

            // Extract price and discount from text content  
            const fullText = $(el).text();
            const priceMatch = fullText.match(/Rs\.?\s?([\d,]+(?:\.\d{2})?)/);
            const discountMatch = fullText.match(/(\d+)%\s*OFF/i);

            if (title && title.length > 10 && priceMatch && link && !link.includes('/login')) {
                const price = `₹${priceMatch[1].replace(/\.00$/, '')}`;
                const discount = discountMatch ? `${discountMatch[1]}% off` : '';

                results.push({
                    title: title.replace(/\.\.\.$/g, '').trim(),
                    price,
                    url: link,
                    imageUrl: '', // PriceBefore doesn't serve images in search HTML
                    rating: '4.0',
                    discount,
                    snippet: 'PriceBefore'
                });
            }
        });

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
            signal: AbortSignal.timeout(8000)
        });

        if (!res.ok) return [];

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('a.result-link').each((i, el) => {
            if (results.length >= 20) return false;
            
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
