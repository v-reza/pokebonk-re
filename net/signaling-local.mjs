// ============ signaling-local.mjs — local in-memory signaling relay adapter ============
// Browser-side adapter that gives net.mjs the Firebase-RTDB-shaped handle it
// expects, backed by the dependency-free /signaling relay in server.mjs (SSE for
// server->client push, POST for client->server).
//
// net.mjs's init(db, uid) consumes:
//   db = { rtdb: { ref(path) -> { on(event, cb), off(), push(value) } }, uid }
//
// Here `ref(path)` parses `rooms/{room}/q/{uid}` and returns a live object:
//   .on('child_added', cb)  opens an EventSource to /signaling/stream and, per
//                           message, calls cb({ val(): rawString, ref.remove() }).
//   .off()                  closes the EventSource.
//   .push(value)            POSTs the raw value to /signaling/send.
//
// The same q/ path carries BOTH WebRTC signaling (SDP/ICE) and the relay-fallback
// gameplay messages, exactly like the RTDB q/ path in net.mjs.

export function localDb(uid, opts = {}) {
  const base = opts.base || '/signaling';
  return { rtdb: localRtdb(uid, base), uid };
}

export function localRtdb(uid, base = '/signaling') {
  return {
    ref(path) {
      const m = /^rooms\/([^/]+)\/q\/([^/]+)$/.exec(path);
      if (!m) throw new Error('signaling-local: unexpected ref path ' + path);
      return new LocalRef(m[1], m[2], uid, base);
    },
  };
}

class LocalRef {
  constructor(room, to, uid, base) {
    this.room = room;
    this.to = to;
    this.uid = uid;
    this.base = base;
    this.es = null;
    this._handlers = [];
  }

  on(event, cb) {
    if (event !== 'child_added') return;
    if (this.es) this.es.close();
    const url = `${this.base}/stream?room=${encodeURIComponent(this.room)}&uid=${encodeURIComponent(this.to)}`;
    const es = this.es = new EventSource(url);
    es.onmessage = (msg) => {
      const data = msg.data;
      // Mimic the RTDB snapshot shape net.mjs's child_added callback expects.
      cb({ val: () => data, ref: { remove: () => Promise.resolve() } });
    };
  }

  off() {
    if (this.es) { this.es.close(); this.es = null; }
  }

  async push(value) {
    const r = await fetch(`${this.base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: this.room, to: this.to, from: this.uid, data: String(value) }),
    });
    if (!r.ok) throw new Error(`signaling-local push failed: ${r.status}`);
  }
}
