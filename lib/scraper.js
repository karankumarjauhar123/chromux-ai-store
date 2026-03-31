import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function fetchGoogleShopping(query) {
    try {
        return await fetchDuckDuckGoLite(query);
    } catch (e) {
        console.error('[Scraper] Top-level error:', e.message);
        return [];
    }
}

export async function fetchDuckDuckGoLite(query) {
    try {
        const searchQuery = encodeURIComponent(`site:amazon.in OR site:flipkart.com OR site:myntra.com OR site:meesho.com ${query}`);
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
