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
// PROVIDER POOLS — Only 3 Providers: Groq, Gemini, Cerebras
// Each with 3 API keys from different accounts
// ============================================================
const pools = {
    groq: {
        keys: (keys.GROQ_KEYS || []).map(k => ({ key: k, used: 0, limit: 800, errored: false })),
        model: 'llama-3.3-70b-versatile',
        apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        format: 'openai',  // OpenAI-compatible API format
        priority: 1         // Fastest — tried first
    },
    gemini: {
        keys: (keys.GEMINI_KEYS || []).map(k => ({ key: k, used: 0, limit: 1200, errored: false })),
        model: 'gemini-2.0-flash',
        apiUrl: 'gemini',   // Custom handler — NOT OpenAI format
        format: 'gemini',
        priority: 2         // Your paid Pro keys — very reliable
    },
    cerebras: {
        keys: (keys.CEREBRAS_KEYS || []).map(k => ({ key: k, used: 0, limit: 500, errored: false })),
        model: 'llama-3.3-70b',
        apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
        format: 'openai',   // OpenAI-compatible API format
        priority: 3          // Backup — still very fast
    }
};

// Track keys that failed in the CURRENT request to avoid retrying them
let failedKeysThisRequest = new Set();

/**
 * Find the next available provider+key combo.
 * Skips: placeholder keys, exhausted keys, errored keys, keys failed this request.
 */
function getNextProvider() {
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
            max_tokens: 1500
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
 * Main entry point — routes the request through available provider keys.
 */
export async function askMegaRouter(messages, systemPrompt) {
    // Reset per-request tracking
    failedKeysThisRequest = new Set();

    // Max attempts = total number of configured valid keys (avoid infinite loops)
    const totalKeys = Object.values(pools)
        .reduce((sum, p) => sum + p.keys.filter(k => !k.key.includes('YOUR_') && k.key.length > 10).length, 0);

    if (totalKeys === 0) {
        return { error: 'No valid API keys configured. Please add your Groq/Gemini/Cerebras keys to keys.json.' };
    }

    const maxAttempts = Math.min(totalKeys, 9);

    // Build the full message array with system prompt for OpenAI-format providers
    const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const target = getNextProvider();

        if (!target) {
            return { error: 'All AI provider keys exhausted for today. Please try again tomorrow.' };
        }

        try {
            console.log(`[MegaRouter] Attempt ${attempt + 1}/${maxAttempts}: ${target.provider} (key ...${target.keyObj.key.slice(-6)})`);

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
            console.log(`[MegaRouter] ✅ Success via ${target.provider}`);
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

    return { error: 'Failed to get a response from any AI provider. Please check your API keys.' };
}
