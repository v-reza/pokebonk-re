// net/coop-ctl-0.8.29.mjs — WebRTC ctl transport adapter for upstream 0.8.29 session (GT).
//
// Bridges the reliable/ordered WebRTC ctl channel with the fork's array-based
// wire messages (LevelBarrier and PickupSync).
//
// Wire shape: { t: 'pb', l: ev }
//   - When `to` is absent, broadcasts via `coop.mesh.broadcast(msg)`.
//   - When `to` is provided, sends via `coop.mesh.sendCtl(to, msg)`.
//   - When `to === 'host'`, resolves host ID in order:
//     opts.hostId → coop.room?.room?.host → coop.room?.host → coop.hostId.
//     Throws if host id cannot be resolved.

/**
 * Builds a ctl transport over an upstream session (GT instance).
 *
 * @param {object} coop  The live GT instance or session object with a mesh.
 * @param {(ev: any[], from: string) => void} [onReceive] Optional receive listener.
 * @param {object} [opts] Options object.
 * @param {string} [opts.hostId] Optional explicit host UID.
 * @returns {{ send: (ev: any[], to?: string) => void, receive: (msg: any, from: string) => any }}
 */
export function ctlTransport(coop, onReceive = null, opts = {}) {
  if (!coop || (!coop.mesh && !coop.room?.mesh)) {
    throw new Error('coop.mesh is unavailable');
  }
  const mesh = coop.mesh || coop.room?.mesh;
  let handler = typeof onReceive === 'function' ? onReceive : null;
  const options = (typeof onReceive === 'object' && onReceive !== null) ? onReceive : (opts || {});

  function resolveHostId() {
    return options.hostId
      ?? coop.room?.room?.host
      ?? coop.room?.host
      ?? coop.hostId;
  }

  function send(ev, to) {
    const msg = { t: 'pb', l: ev };
    if (to !== undefined && to !== null) {
      let target = to;
      if (to === 'host') {
        const hostId = resolveHostId();
        if (!hostId) {
          throw new Error('ctlTransport: host id unresolved for addressed message');
        }
        target = hostId;
      }
      mesh.sendCtl(target, msg);
    } else {
      mesh.broadcast(msg);
    }
  }

  function receive(msg, from) {
    const ev = (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.t === 'pb')
      ? msg.l
      : msg;
    if (typeof handler === 'function') {
      handler(ev, from);
    }
    return ev;
  }

  return {
    send,
    receive,
    set onReceive(fn) { handler = fn; },
    get onReceive() { return handler; },
  };
}
/**
 * Room signaling relay transport fallback when WebRTC ctl mesh cannot be built.
 *
 * @param {object} coop
 * @param {object} opts
 * @param {(to: string, kind: string, data: any) => Promise<any>|void} opts.signal
 * @param {(after: number) => Promise<any[]>|any[]} [opts.poll]
 * @param {string} [opts.hostId]
 * @param {string} [opts.me]
 * @param {(ev: any[], from: string) => void} [opts.onMessage]
 * @param {(ev: any[], from: string) => void} [opts.onReceive]
 * @param {number} [opts.intervalMs]
 * @returns {{ send: (ev: any[], to?: string) => void, receive: (msg: any, from: string) => any, pollOnce: () => Promise<void>, close: () => void }}
 */
export function roomSignalTransport(coop, opts = {}) {
  let handler = typeof opts.onMessage === 'function'
    ? opts.onMessage
    : (typeof opts.onReceive === 'function' ? opts.onReceive : null);
  let cursor = 0;
  let timer = null;

  function resolveHostId() {
    return opts.hostId
      ?? coop?.room?.room?.host
      ?? coop?.room?.host
      ?? coop?.hostId;
  }

  function send(ev, to) {
    let target = to;
    if (to !== undefined && to !== null) {
      if (to === 'host') {
        const hostId = resolveHostId();
        if (!hostId) {
          throw new Error('ctlTransport: host id unresolved for addressed message');
        }
        target = hostId;
      }
    } else {
      target = '*';
    }
    opts.signal(target, 'pb', { l: ev });
  }

  function receive(msg, from) {
    const ev = (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.t === 'pb')
      ? msg.l
      : msg;
    if (typeof handler === 'function') {
      handler(ev, from);
    }
    return ev;
  }

  async function pollOnce() {
    if (typeof opts.poll !== 'function') return;
    try {
      const res = await opts.poll(cursor);
      const signals = Array.isArray(res) ? res : (res?.signals || []);
      for (const sig of signals) {
        if (!sig || typeof sig.id !== 'number') continue;
        if (sig.id > cursor) cursor = sig.id;
        if (opts.me && sig.from === opts.me) continue;
        if (sig.kind === 'pb' && sig.data && Array.isArray(sig.data.l)) {
          receive({ t: 'pb', l: sig.data.l }, sig.from);
        }
      }
    } catch {
      // transient poll error
    }
  }

  if (opts.intervalMs && opts.intervalMs > 0 && typeof opts.poll === 'function') {
    timer = setInterval(pollOnce, opts.intervalMs);
  }

  return {
    send,
    receive,
    pollOnce,
    close() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    set onReceive(fn) { handler = fn; },
    get onReceive() { return handler; },
    set onMessage(fn) { handler = fn; },
    get onMessage() { return handler; },
    get cursor() { return cursor; },
  };
}
