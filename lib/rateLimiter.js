const ipMap = new Map();

// Clean up memory occasionally
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of ipMap.entries()) {
        if (now > data.resetTime) {
            ipMap.delete(ip);
        }
    }
}, 60000).unref?.();

export function checkRateLimit(req, maxRequests = 30, windowMs = 60000) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    
    let record = ipMap.get(ip);
    if (!record || now > record.resetTime) {
        record = {
            count: 0,
            resetTime: now + windowMs
        };
        ipMap.set(ip, record);
    }
    
    record.count++;
    
    const allowed = record.count <= maxRequests;
    const remaining = Math.max(0, maxRequests - record.count);
    
    return {
        allowed,
        remaining,
        resetTime: record.resetTime
    };
}
