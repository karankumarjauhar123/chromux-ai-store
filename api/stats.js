// Router Stats — Monitor AI provider health & capacity
import { getRouterStats } from '../lib/megaRouter.js';

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const stats = getRouterStats();
    
    // Calculate total capacity
    let totalRPM = 0;
    let totalKeys = 0;
    let activeKeys = 0;
    
    for (const [name, s] of Object.entries(stats)) {
        totalRPM += s.rpmCapacity;
        totalKeys += s.totalKeys;
        activeKeys += s.activeKeys;
    }
    
    // Estimate concurrent user capacity (avg user = 2 req/min)
    const estimatedUsers = Math.floor(totalRPM / 2);
    
    return res.status(200).json({
        status: activeKeys > 0 ? 'healthy' : 'degraded',
        capacity: {
            totalRPM: totalRPM + ' + Pollinations unlimited',
            estimatedConcurrentUsers: estimatedUsers + '+ (with Pollinations overflow)',
            totalKeys,
            activeKeys,
        },
        providers: stats,
        pollinations: 'unlimited (last resort fallback)',
        timestamp: new Date().toISOString(),
    });
}
