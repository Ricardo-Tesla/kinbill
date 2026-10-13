// A tiny in-memory rate limiter (no extra package). Once Kin-bill is online anyone can reach it,
// so we stop one visitor from using up the AI key or guessing David's PIN.

export function createCounter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  return {
    // Adds one hit; returns true when the key is over the limit.
    hit(key, now = Date.now()) {
      let h = hits.get(key);
      if (!h || now >= h.resetAt) {
        h = { count: 0, resetAt: now + windowMs };
        hits.set(key, h);
      }
      h.count += 1;
      if (hits.size > 10000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k); // tidy up
      return h.count > max;
    },
    blocked(key, now = Date.now()) {
      const h = hits.get(key);
      return Boolean(h && now < h.resetAt && h.count >= max);
    },
    retryAfterSeconds(key, now = Date.now()) {
      const h = hits.get(key);
      return h ? Math.max(1, Math.ceil((h.resetAt - now) / 1000)) : 1;
    },
  };
}

// Express middleware: at most `max` requests per `windowMs` from one address.
export function rateLimit({ windowMs, max, message }) {
  const counter = createCounter({ windowMs, max });
  return (req, res, next) => {
    if (!counter.hit(req.ip)) return next();
    res.set('Retry-After', String(counter.retryAfterSeconds(req.ip)));
    res.status(429).json({ error: message, code: 'RATE_LIMITED' });
  };
}
