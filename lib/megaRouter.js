import fs from 'fs';
import path from 'path';

// Load keys from keys.json (only Groq, Gemini, Cerebras)
let keys = { GROQ_KEYS: [], GEMINI_KEYS: [], CEREBRAS_KEYS: [] };
try {
  const keysData = fs.readFileSync(path.resolve(process.cwd(), 'keys.json'), 'utf8');
  keys = JSON.parse(keysData);
} catch (e) {
  console.log("[MegaRouter] No keys.json found. Reading from Environment Variables.");
}
// Bulletproof Support for Vercel Environment Variables
const extractEnv = (val) => val ? val.split(',').map(k => k.replace(/["']/g, '').trim()) : [];

const groqEnv = process.env.GROQ_KEYS || process.env.GROQ_KEY || process.env.GROQ_API_KEY;
if (groqEnv) keys.GROQ_KEYS = extractEnv(groqEnv);

const geminiEnv = process.env.GEMINI_KEYS || process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
if (geminiEnv) keys.GEMINI_KEYS = extractEnv(geminiEnv);

const cerebrasEnv = process.env.CEREBRAS_KEYS || process.env.CEREBRAS_KEY || process.env.CEREBRAS_API_KEY;
if (cerebrasEnv) keys.CEREBRAS_KEYS = extractEnv(cerebrasEnv);

// ============================================================
// POLLINATIONS AI — FREE or Keyed, Always tried FIRST!
// Priority 0 — Saves Groq/Gemini/Cerebras API key usage
// With key (pk_): Stable, priority access
// Without key: Anonymous free mode (may rate-limit under heavy load)
// ============================================================
const POLLINATIONS_API = 'https://text.pollinations.ai/openai';
const POLLINATIONS_MODEL = 'openai';  // Uses GPT-4o-mini via Pollinations

// Load Pollinations key (optional — works without it too)
const pollinationsKeyFromJson = keys.POLLINATIONS_KEY || '';
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY || pollinationsKeyFromJson;
if (POLLINATIONS_KEY) {
    console.log('[MegaRouter] 🔑 Pollinations key loaded — stable/priority access enabled');
} else {
    console.log('[MegaRouter] 🆓 Pollinations running in anonymous FREE mode (no key)');
}

/**
 * Call Pollinations AI — FREE, no API key needed!
 * Uses OpenAI-compatible endpoint at text.pollinations.ai/openai
 * Returns the AI response text or throws on failure.
 */
async function callPollinationsAI(messages, systemPrompt) {
    const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000); // 55s timeout (Vercel max = 60s)

    try {
        // Build headers — add Authorization if key is available
        const headers = { 'Content-Type': 'application/json' };
        if (POLLINATIONS_KEY) {
            headers['Authorization'] = `Bearer ${POLLINATIONS_KEY}`;
        }

        const res = await fetch(POLLINATIONS_API, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: POLLINATIONS_MODEL,
                messages: fullMessages,
                temperature: 0.7,
                max_tokens: 3000,  // Enough for 5-8 products with full JSON
                seed: Math.floor(Math.random() * 100000)  // Random seed for variety
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Pollinations ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data = await res.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Pollinations: Unexpected response structure');
        }
        return data.choices[0].message.content;
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

// ============================================================
// PROVIDER POOLS — Groq, Gemini, Cerebras (Backup/Fallback)
// Each with 3 API keys from different accounts
// Used ONLY when Pollinations AI fails
// ============================================================
const pools = {
    groq: {
        keys: (keys.GROQ_KEYS || []).map(k => ({ key: k, used: 0, limit: 800, errored: false })),
        model: 'llama-3.3-70b-versatile',
        apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        format: 'openai',  // OpenAI-compatible API format
        priority: 1         // Fastest backup — tried first after Pollinations
    },
    gemini: {
        keys: (keys.GEMINI_KEYS || []).map(k => ({ key: k, used: 0, limit: 1200, errored: false })),
        model: 'gemini-2.0-flash',
        apiUrl: 'gemini',   // Custom handler — NOT OpenAI format
        format: 'gemini',
        priority: 2         // Your paid Pro keys — very reliable backup
    },
    cerebras: {
        keys: (keys.CEREBRAS_KEYS || []).map(k => ({ key: k, used: 0, limit: 500, errored: false })),
        model: 'llama-3.3-70b',
        apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
        format: 'openai',   // OpenAI-compatible API format
        priority: 3          // Last backup — still very fast
    }
};

/**
 * Find the next available provider+key combo.
 * Skips: placeholder keys, exhausted keys, errored keys, keys failed this request.
 */
function getNextProvider(failedKeysThisRequest) {
    const sorted = Object.entries(pools).sort((a, b) => a[1].priority - b[1].priority);

    for (const [name, pool] of sorted) {
        // Sort keys by usage (least-used first) to spread load
        const available = pool.keys
            .sort((a, b) => a.used - b.used)
            .find(k =>
                k.used < k.limit &&
                !k.errored &&
                !k.key.includes('YOUR_') &&
                k.key.length > 10 &&
                !failedKeysThisRequest.has(k.key)
            );

        if (available) {
            return {
                provider: name,
                keyObj: available,
                model: pool.model,
                apiUrl: pool.apiUrl,
                format: pool.format
            };
        }
    }
    return null;
}

/**
 * Call an OpenAI-compatible API (Groq, Cerebras).
 */
async function callOpenAIFormat(apiUrl, apiKey, model, messages) {
    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.7,
            max_tokens: 3000
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`API ${res.status}: ${errText.substring(0, 200)}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Unexpected response structure: missing choices[0].message');
    }
    return data.choices[0].message.content;
}

/**
 * Call Gemini REST API (different request/response format).
 */
async function callGeminiFormat(apiKey, model, messages, systemPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Gemini requires alternating user/model roles and cannot start with 'model'
    const contents = [];
    for (const m of messages) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: m.content }] });
    }

    const body = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: contents
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        const err = new Error(`Gemini ${res.status}: ${errText.substring(0, 200)}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Unexpected Gemini response: missing candidates[0].content');
    }
    return data.candidates[0].content.parts[0].text;
}

/**
 * Main entry point — Pollinations FIRST (free), then fallback to keyed providers.
 * 
 * Flow:
 *   1. 🆓 Pollinations AI (FREE, unlimited, no API key) — handles 99% of traffic
 *   2. 🔑 Groq (fast, free tier keys)  — backup
 *   3. 🔑 Gemini (reliable, free tier)  — backup
 *   4. 🔑 Cerebras (fast, free tier)    — backup
 */
export async function askMegaRouter(messages, systemPrompt) {
    // ============================================================
    // STEP 1: Try Pollinations AI FIRST — FREE for lakhs of users!
    // ============================================================
    try {
        console.log('[MegaRouter] 🆓 Trying Pollinations AI (FREE — no API key)...');
        const pollinationsResponse = await callPollinationsAI(messages, systemPrompt);
        
        if (pollinationsResponse && pollinationsResponse.trim().length > 10) {
            console.log('[MegaRouter] ✅ Pollinations AI success! Zero cost 🎉');
            return { response: pollinationsResponse, provider: 'pollinations-free' };
        } else {
            console.log('[MegaRouter] ⚠️ Pollinations returned empty/short response, falling back...');
        }
    } catch (e) {
        console.error('[MegaRouter] ⚠️ Pollinations AI failed:', e.message);
        console.log('[MegaRouter] Falling back to keyed providers (Groq/Gemini/Cerebras)...');
    }

    // ============================================================
    // STEP 2: Fallback to keyed providers (Groq → Gemini → Cerebras)
    // ============================================================
    const failedKeysThisRequest = new Set();

    // Max attempts = total number of configured valid keys (avoid infinite loops)
    const totalKeys = Object.values(pools)
        .reduce((sum, p) => sum + p.keys.filter(k => !k.key.includes('YOUR_') && k.key.length > 10).length, 0);

    if (totalKeys === 0) {
        return { error: 'Pollinations AI failed and no backup API keys configured.' };
    }

    const maxAttempts = Math.min(totalKeys, 9);

    // Build the full message array with system prompt for OpenAI-format providers
    const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const target = getNextProvider(failedKeysThisRequest);

        if (!target) {
            return { error: 'All AI provider keys exhausted for today. Please try again tomorrow.' };
        }

        try {
            console.log(`[MegaRouter] 🔑 Backup attempt ${attempt + 1}/${maxAttempts}: ${target.provider} (key ...${target.keyObj.key.slice(-6)})`);

            let responseText;

            if (target.format === 'openai') {
                responseText = await callOpenAIFormat(
                    target.apiUrl,
                    target.keyObj.key,
                    target.model,
                    openaiMessages
                );
            } else {
                // Gemini format
                responseText = await callGeminiFormat(
                    target.keyObj.key,
                    target.model,
                    messages,
                    systemPrompt
                );
            }

            // Success! Increment usage counter
            target.keyObj.used++;
            console.log(`[MegaRouter] ✅ Success via ${target.provider} (backup)`);
            return { response: responseText, provider: target.provider };

        } catch (e) {
            console.error(`[MegaRouter] ❌ ${target.provider} failed:`, e.message);

            // Mark this key as failed for this request cycle
            failedKeysThisRequest.add(target.keyObj.key);

            // If rate limited (429), mark key as fully exhausted
            if (e.status === 429) {
                target.keyObj.used = target.keyObj.limit;
                console.log(`[MegaRouter] Key exhausted (429), will try next key`);
            }

            // If auth error (401/403), mark key as permanently errored
            if (e.status === 401 || e.status === 403) {
                target.keyObj.errored = true;
                console.log(`[MegaRouter] Key invalid (${e.status}), marked as errored`);
            }
        }
    }

    return { error: 'Failed to get a response from any AI provider (Pollinations + all backup keys tried).' };
}
