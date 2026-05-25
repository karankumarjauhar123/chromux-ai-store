import fs from 'fs';
import path from 'path';

// ============================================================
// 🚀 MEGA ROUTER v3 — Production-Grade AI Router
// Handles 1000s of concurrent users with smart load balancing
// Priority: Cerebras → Groq → OpenRouter → Gemini → Pollinations
// ============================================================

// --- Load API Keys (keys.json + Environment Variables) ---
let keys = {};
try {
    const keysData = fs.readFileSync(path.resolve(process.cwd(), 'keys.json'), 'utf8');
    keys = JSON.parse(keysData);
} catch (e) {
    console.log("[MegaRouter] No keys.json found. Reading from Environment Variables.");
}

// Bulletproof: Support comma-separated env vars
const extractEnv = (val) => val ? val.split(',').map(k => k.replace(/["']/g, '').trim()).filter(k => k.length > 5) : [];

// Load all provider keys from env (overrides keys.json if present)
const envMap = {
    GROQ_KEYS:       ['GROQ_KEYS', 'GROQ_KEY', 'GROQ_API_KEY'],
    GEMINI_KEYS:     ['GEMINI_KEYS', 'GEMINI_KEY', 'GEMINI_API_KEY'],
    CEREBRAS_KEYS:   ['CEREBRAS_KEYS', 'CEREBRAS_KEY', 'CEREBRAS_API_KEY'],
    OPENROUTER_KEYS: ['OPENROUTER_KEYS', 'OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
};

for (const [jsonKey, envNames] of Object.entries(envMap)) {
    for (const envName of envNames) {
        if (process.env[envName]) {
            keys[jsonKey] = extractEnv(process.env[envName]);
            break;
        }
    }
    if (!keys[jsonKey]) keys[jsonKey] = [];
}

// Pollinations key (optional)
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY || keys.POLLINATIONS_KEY || '';

// ============================================================
// 🔄 SMART KEY MANAGER — Round-robin, cooldowns, rate tracking
// Designed for 1000s of concurrent users
// ============================================================

class KeyManager {
    constructor() {
        this.providers = {};
        this.roundRobinIndex = {};  // Per-provider round-robin counter
        this.cooldowns = new Map(); // key -> cooldown expiry timestamp
        this.minuteCounters = {};   // Per-provider requests this minute
        this.minuteResetAt = Date.now() + 60000;
    }

    /**
     * Register a provider with its keys and config
     */
    addProvider(name, config) {
        const validKeys = (config.keys || []).filter(k => k && k.length > 10 && !k.includes('YOUR_'));
        
        this.providers[name] = {
            ...config,
            keys: validKeys.map(k => ({
                key: k,
                requestsThisMinute: 0,
                totalUsed: 0,
                errored: false,
                lastError: null,
            })),
        };
        this.roundRobinIndex[name] = 0;
        this.minuteCounters[name] = 0;
        
        if (validKeys.length > 0) {
            console.log(`[MegaRouter] ✅ ${name}: ${validKeys.length} key(s) loaded (limit: ${config.rpmPerKey}/min each, ~${validKeys.length * config.rpmPerKey} RPM total)`);
        }
    }

    /**
     * Reset per-minute counters every 60 seconds
     */
    _checkMinuteReset() {
        if (Date.now() > this.minuteResetAt) {
            for (const [name, provider] of Object.entries(this.providers)) {
                provider.keys.forEach(k => { k.requestsThisMinute = 0; });
                this.minuteCounters[name] = 0;
            }
            this.minuteResetAt = Date.now() + 60000;
        }
    }

    /**
     * Check if a key is in cooldown (rate-limited recently)
     */
    _isInCooldown(key) {
        const expiry = this.cooldowns.get(key);
        if (!expiry) return false;
        if (Date.now() > expiry) {
            this.cooldowns.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Put a key in cooldown for N seconds
     */
    setCooldown(key, seconds = 60) {
        this.cooldowns.set(key, Date.now() + (seconds * 1000));
    }

    /**
     * Get the next available provider + key using round-robin
     * Skips: errored keys, cooled-down keys, exhausted keys
     * Returns null if nothing available
     */
    getNext(failedThisRequest = new Set()) {
        this._checkMinuteReset();

        // Sort providers by priority
        const sorted = Object.entries(this.providers)
            .filter(([_, p]) => p.keys.length > 0)
            .sort((a, b) => a[1].priority - b[1].priority);

        for (const [name, provider] of sorted) {
            const numKeys = provider.keys.length;
            if (numKeys === 0) continue;

            // Try each key in round-robin order
            for (let i = 0; i < numKeys; i++) {
                const idx = (this.roundRobinIndex[name] + i) % numKeys;
                const keyObj = provider.keys[idx];

                // Skip if: errored, failed this request, in cooldown, or RPM exceeded
                if (keyObj.errored) continue;
                if (failedThisRequest.has(keyObj.key)) continue;
                if (this._isInCooldown(keyObj.key)) continue;
                if (keyObj.requestsThisMinute >= provider.rpmPerKey) continue;

                // Found a valid key! Advance round-robin
                this.roundRobinIndex[name] = (idx + 1) % numKeys;
                
                return {
                    provider: name,
                    keyObj,
                    model: provider.model,
                    apiUrl: provider.apiUrl,
                    format: provider.format,
                    timeout: provider.timeout || 30000,
                };
            }
        }
        return null;
    }

    /**
     * Record a successful request
     */
    recordSuccess(keyObj) {
        keyObj.requestsThisMinute++;
        keyObj.totalUsed++;
    }

    /**
     * Record a failed request with smart error handling
     */
    recordFailure(keyObj, errorStatus) {
        if (errorStatus === 429) {
            // Rate limited — cooldown for 60s, not permanently dead
            this.setCooldown(keyObj.key, 60);
            console.log(`[MegaRouter] ⏸️ Key ...${keyObj.key.slice(-6)} rate-limited, cooling 60s`);
        } else if (errorStatus === 401 || errorStatus === 403) {
            // Auth error — permanently mark as errored
            keyObj.errored = true;
            console.log(`[MegaRouter] ❌ Key ...${keyObj.key.slice(-6)} auth failed, disabled`);
        } else {
            // Transient error — short cooldown
            this.setCooldown(keyObj.key, 10);
        }
        keyObj.lastError = Date.now();
    }

    /**
     * Get stats for monitoring
     */
    getStats() {
        const stats = {};
        for (const [name, provider] of Object.entries(this.providers)) {
            const active = provider.keys.filter(k => !k.errored && !this._isInCooldown(k.key));
            stats[name] = {
                totalKeys: provider.keys.length,
                activeKeys: active.length,
                rpmCapacity: active.length * provider.rpmPerKey,
                totalUsed: provider.keys.reduce((s, k) => s + k.totalUsed, 0),
            };
        }
        return stats;
    }
}

// ============================================================
// 🏗️ INITIALIZE PROVIDERS — Speed-priority order
// ============================================================

const keyManager = new KeyManager();

// 🥇 Priority 1: Cerebras — FASTEST (2-4 sec)
keyManager.addProvider('cerebras', {
    keys: keys.CEREBRAS_KEYS || [],
    model: 'llama-3.3-70b',
    apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
    format: 'openai',
    priority: 1,
    rpmPerKey: 30,   // 30 req/min per key (free tier)
    timeout: 15000,
});

// 🥈 Priority 2: Groq — FAST (3-5 sec)
keyManager.addProvider('groq', {
    keys: keys.GROQ_KEYS || [],
    model: 'llama-3.3-70b-versatile',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    format: 'openai',
    priority: 2,
    rpmPerKey: 30,   // 30 req/min per key (free tier)
    timeout: 20000,
});

// 🥉 Priority 3: OpenRouter — FLEXIBLE (3-8 sec, many models)
keyManager.addProvider('openrouter', {
    keys: keys.OPENROUTER_KEYS || [],
    model: 'meta-llama/llama-3.3-70b-instruct:free',  // Free model!
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    format: 'openrouter',
    priority: 3,
    rpmPerKey: 20,   // Conservative — depends on plan
    timeout: 25000,
});

// 🏅 Priority 4: Gemini — RELIABLE (5-8 sec)
keyManager.addProvider('gemini', {
    keys: keys.GEMINI_KEYS || [],
    model: 'gemini-2.0-flash',
    apiUrl: 'gemini',
    format: 'gemini',
    priority: 4,
    rpmPerKey: 15,   // 15 req/min per key (free tier)
    timeout: 25000,
});

// Log total capacity
const stats = keyManager.getStats();
const totalRPM = Object.values(stats).reduce((s, p) => s + p.rpmCapacity, 0);
console.log(`[MegaRouter] 🚀 Total capacity: ~${totalRPM} RPM across ${Object.values(stats).reduce((s, p) => s + p.totalKeys, 0)} keys + Pollinations unlimited`);

// ============================================================
// 📡 API CALLERS — One per format type
// ============================================================

/**
 * Call OpenAI-compatible API (Groq, Cerebras)
 */
async function callOpenAIFormat(apiUrl, apiKey, model, messages, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7,
                max_tokens: 3000
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`API ${res.status}: ${errText.substring(0, 200)}`);
            err.status = res.status;
            throw err;
        }

        const data = await res.json();
        if (!data.choices?.[0]?.message?.content) {
            throw new Error('Unexpected response: missing choices[0].message.content');
        }
        return data.choices[0].message.content;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

/**
 * Call OpenRouter API (OpenAI-compatible + extra headers)
 */
async function callOpenRouterFormat(apiKey, model, messages, timeoutMs = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://chromux-ai-store.vercel.app',
                'X-Title': 'Chromux AI Store',
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7,
                max_tokens: 3000,
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`OpenRouter ${res.status}: ${errText.substring(0, 200)}`);
            err.status = res.status;
            throw err;
        }

        const data = await res.json();
        if (!data.choices?.[0]?.message?.content) {
            throw new Error('OpenRouter: Unexpected response structure');
        }
        return data.choices[0].message.content;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

/**
 * Call Gemini REST API
 */
async function callGeminiFormat(apiKey, model, messages, systemPrompt, timeoutMs = 25000) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const contents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            const errText = await res.text();
            const err = new Error(`Gemini ${res.status}: ${errText.substring(0, 200)}`);
            err.status = res.status;
            throw err;
        }

        const data = await res.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Gemini: Unexpected response structure');
        }
        return data.candidates[0].content.parts[0].text;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

/**
 * Call Pollinations AI — FREE unlimited last resort
 */
async function callPollinationsAI(messages, systemPrompt) {
    const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (POLLINATIONS_KEY) {
            headers['Authorization'] = `Bearer ${POLLINATIONS_KEY}`;
        }

        const res = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'openai',
                messages: fullMessages,
                temperature: 0.7,
                max_tokens: 3000,
                seed: Math.floor(Math.random() * 100000)
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Pollinations ${res.status}: ${errText.substring(0, 200)}`);
        }

        const data = await res.json();
        if (!data.choices?.[0]?.message?.content) {
            throw new Error('Pollinations: Unexpected response');
        }
        return data.choices[0].message.content;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// ============================================================
// 🧠 MAIN ROUTER — Smart failover with load balancing
// ============================================================

/**
 * Main entry point — Speed-priority routing with auto-failover
 * 
 * Flow (fastest → slowest):
 *   1. ⚡ Cerebras (2-4s)     — Fastest AI inference
 *   2. ⚡ Groq (3-5s)         — Fast Llama inference
 *   3. 🌐 OpenRouter (3-8s)   — Multi-model flexibility
 *   4. 🔷 Gemini (5-8s)       — Google's reliable model
 *   5. 🆓 Pollinations (20-30s) — FREE unlimited fallback
 * 
 * Each provider has multiple keys with round-robin rotation.
 * Rate-limited keys auto-cooldown for 60s instead of dying.
 * Designed for 1000+ concurrent users.
 */
export async function askMegaRouter(messages, systemPrompt) {
    const startTime = Date.now();
    const failedThisRequest = new Set();

    // ---- STEP 1: Try all fast keyed providers ----
    const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
    ];

    // Try up to 12 attempts across all providers (handles many keys)
    const maxAttempts = 12;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const target = keyManager.getNext(failedThisRequest);
        if (!target) break;  // No more available keys

        try {
            const elapsed = Date.now() - startTime;
            console.log(`[MegaRouter] ⚡ #${attempt + 1}: ${target.provider} (key ...${target.keyObj.key.slice(-6)}) [${elapsed}ms elapsed]`);

            let responseText;

            if (target.format === 'openai') {
                responseText = await callOpenAIFormat(
                    target.apiUrl, target.keyObj.key, target.model,
                    openaiMessages, target.timeout
                );
            } else if (target.format === 'openrouter') {
                responseText = await callOpenRouterFormat(
                    target.keyObj.key, target.model,
                    openaiMessages, target.timeout
                );
            } else if (target.format === 'gemini') {
                responseText = await callGeminiFormat(
                    target.keyObj.key, target.model,
                    messages, systemPrompt, target.timeout
                );
            }

            // Success!
            keyManager.recordSuccess(target.keyObj);
            const totalMs = Date.now() - startTime;
            console.log(`[MegaRouter] ✅ ${target.provider} responded in ${totalMs}ms`);
            return { response: responseText, provider: target.provider };

        } catch (e) {
            console.error(`[MegaRouter] ❌ ${target.provider} failed:`, e.message);
            failedThisRequest.add(target.keyObj.key);
            keyManager.recordFailure(target.keyObj, e.status);
        }
    }

    // ---- STEP 2: Pollinations — FREE unlimited last resort ----
    try {
        console.log(`[MegaRouter] 🆓 All fast providers exhausted. Trying Pollinations...`);
        const pollinationsResponse = await callPollinationsAI(messages, systemPrompt);

        if (pollinationsResponse && pollinationsResponse.trim().length > 10) {
            const totalMs = Date.now() - startTime;
            console.log(`[MegaRouter] ✅ Pollinations responded in ${totalMs}ms`);
            return { response: pollinationsResponse, provider: 'pollinations-free' };
        }
    } catch (e) {
        console.error('[MegaRouter] ❌ Pollinations also failed:', e.message);
    }

    // ---- All providers failed ----
    const totalMs = Date.now() - startTime;
    console.error(`[MegaRouter] 💀 ALL providers failed after ${totalMs}ms`);
    return { error: 'All AI providers failed. Please try again in a moment.' };
}

// Export stats endpoint for monitoring
export function getRouterStats() {
    return keyManager.getStats();
}
