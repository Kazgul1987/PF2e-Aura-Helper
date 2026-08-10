export class EventDeduplicator {
  #entries = new Map();

  has(key) {
    this.cleanup();
    return (this.#entries.get(key) ?? 0) > Date.now();
  }

  add(key, ttlMs) {
    this.cleanup();
    this.#entries.set(key, Date.now() + ttlMs);
  }

  checkAndAdd(key, ttlMs) {
    if (this.has(key)) return true;
    this.add(key, ttlMs);
    return false;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(key);
    }
  }

  clear() {
    this.#entries.clear();
  }
}
