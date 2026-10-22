// Offline stand-in for Cloudflare Turnstile.
// The local server has no challenge to solve, so render() immediately reports success.
window.turnstile = {
  render(_el, opts) {
    const id = Math.floor(Math.random() * 1e9);
    setTimeout(() => {
      try { opts?.callback?.('local-bypass'); } catch { /* ignore */ }
    }, 0);
    return id;
  },
  remove() {},
  reset() {},
  getResponse() { return 'local-bypass'; },
  isExpired() { return false; },
};
