// Rate limit: a tiny in-memory rate limiter (no extra package).
// Once Kin-bill is online anyone can reach it, so we stop one visitor from using up
// the AI key or guessing David's PIN. Counts live in memory and reset on restart,
// which is enough for a single small server.

/**
 * Creates a counter of hits per key (usually a visitor's address) in a fixed time window.
 * @param {{ windowMs: number, max: number }} options  window length in ms and hits allowed per window
 * @returns {{ hit: Function, blocked: Function, retryAfterSeconds: Function }} the counter
 */
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
      if (hits.size > 10000) for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k); // drop expired keys so memory stays bounded
      return h.count > max;
    },
    // True when the key has used all its hits, so the next one would be over the limit.
    blocked(key, now = Date.now()) {
      const h = hits.get(key);
      return Boolean(h && now < h.resetAt && h.count >= max);
    },
    // Seconds until the key's window resets (at least 1), for the Retry-After header.
    retryAfterSeconds(key, now = Date.now()) {
      const h = hits.get(key);
      return h ? Math.max(1, Math.ceil((h.resetAt - now) / 1000)) : 1;
    },
  };
}

/**
 * Express middleware that allows at most `max` requests per `windowMs` from one address.
 * Extra requests get a 429 answer with a Retry-After header and a friendly message.
 * @param {{ windowMs: number, max: number, message: string }} options  limit and the message to show
 * @returns {Function} Express middleware
 */
export function rateLimit({ windowMs, max, message }) {
  const counter = createCounter({ windowMs, max });
  return (req, res, next) => {
    if (!counter.hit(req.ip)) return next();
    res.set('Retry-After', String(counter.retryAfterSeconds(req.ip)));
    res.status(429).json({ error: message, code: 'RATE_LIMITED' });
  };
}
