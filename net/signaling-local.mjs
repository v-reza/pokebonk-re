// ============ signaling-local.mjs — local signaling relay + room store ============
// Browser-side adapter that gives net.mjs (and the co-op UI) the Firebase-RTDB-shaped
// handle they expect, backed by the dependency-free /signaling relay in server.mjs.
//
// The relay itself is stateless (SSE push + POST, no storage), so this module adds the
// two things the RTDB provided for free:
//
//   1. q/ channels — identical to the RTDB: a player pushes to the recipient's queue
//      `rooms/{room}/q/{to}`. net.mjs uses this for SDP/ICE and for relay gameplay
//      frames. Pure passthrough: the sender never needs the message locally.
//
//   2. room state — `rooms/{room}/{host,open,at,m/{uid}}`, which the co-op panel
//      creates/joins and which carries the member list. Because the relay keeps
//      nothing, the tree is REPLICATED BY GOSSIP on a well-known channel
//      (`__pbstate__`): every write is broadcast as an op, a tab that subscribes
//      sends 'hello', and whoever already holds the tree answers with a 'snapshot'.
//      That is enough for a room created in one tab and joined from another (the
//      creator is alive by definition while people are joining).
//
// The shape of what net.mjs consumes is unchanged:
//   db = { rtdb: { ref(path) -> Ref }, uid, ServerValue }
//   Ref: .on('child_added'|'child_changed'|'child_removed'|'value', cb) · .off()
//        .once('value') · .set(v) · .update(obj) · .remove() · .push(v) · .child(k)
//
// The transport is injectable (`opts.io`) so the room store can be unit-tested
// without a browser or a server (see signaling-local.test.mjs).

const STATE_UID = '__pbstate__';
// 'no snapshot seen yet' — distinct from an empty tree (null).
const NEVER = Symbol('never');
const PROTO = 1;

/** Firebase-shaped db handle: { rtdb, uid, ServerValue }. */
export function localDb(uid, opts = {}) {
  const base = opts.base || '/signaling';
  return {
    rtdb: localRtdb(uid, base, opts.io),
    uid,
    ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } },
    isLocal: true,
  };
}

/** Browser transport: SSE for server -> client, POST for client -> server. */
export function defaultIo(base = '/signaling') {
  return {
    open(room, to, onData) {
      const url = `${base}/stream?room=${encodeURIComponent(room)}&uid=${encodeURIComponent(to)}`;
      const es = new EventSource(url);
      // Raw payload, exactly what the sender pushed (a JSON string for both the
      // net.mjs queue and the room-state gossip): decoding is the caller's job.
      es.onmessage = (e) => onData(e.data);
      return { close() { try { es.close(); } catch { /* already closed */ } } };
    },
    send(room, to, data) {
      return fetch(`${base}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room, to, data }),
      }).then((r) => { if (!r.ok) throw new Error(`signaling-local push failed: ${r.status}`); });
    },
  };
}

/** In-memory transport for tests: every client shares one bus. */
export function memoryIo() {
  const channels = new Map();          // `${room}/${uid}` -> Set<cb>
  const key = (room, to) => `${room}/${to}`;
  return {
    open(room, to, onData) {
      const k = key(room, to);
      let set = channels.get(k);
      if (!set) channels.set(k, (set = new Set()));
      set.add(onData);
      return { close() { set.delete(onData); if (!set.size) channels.delete(k); } };
    },
    send(room, to, data) {
      const set = channels.get(key(room, to));
      if (set) for (const cb of [...set]) cb(data);
      return Promise.resolve();
    },
    count() { return channels.size; },
  };
}

export function localRtdb(uid, base = '/signaling', io) {
  const transport = io || defaultIo(base);
  const links = new Map();             // room code -> RoomLink (room-state replication)
  const ctx = {
    io: transport,
    linkFor(code) {
      let l = links.get(code);
      if (!l) { l = new RoomLink(code, uid, transport); links.set(code, l); }
      return l;
    },
  };
  return { ref(path) { return new LocalRef(ctx, path, uid); } };
}

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function getIn(node, rel) {
  if (!rel) return node;
  let cur = node;
  for (const part of rel.split('/')) {
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setIn(node, rel, value) {
  if (!rel) return value == null ? null : clone(value);
  const parts = rel.split('/');
  if (!isObj(node)) node = {};
  let cur = node;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (value == null) delete cur[last];
  else cur[last] = clone(value);
  return node;
}

/** `.sv` server timestamps become plain numbers; RTDB has no placeholder here. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isObj(value)) return value;
  if (value['.sv'] === 'timestamp') return Date.now();
  const out = {};
  for (const k of Object.keys(value)) out[k] = normalize(value[k]);
  return out;
}

// ---------------------------------------------------------------------------
// room link: the replicated tree for one room
// ---------------------------------------------------------------------------

class RoomLink {
  constructor(code, uid, io) {
    this.code = code;
    this.uid = uid;
    this.io = io;
    this.tree = null;                  // replicated room node
    this.rev = 0;                      // ms timestamp of the last applied state
    this.subs = new Set();             // LocalRefs with handlers
    this.conn = null;
    this.helloT = 0;
    this.retries = 0;
    this.retryT = 0;
  }

  connect() {
    if (this.conn) return;
    this.conn = this.io.open(this.code, STATE_UID, (msg) => this.onMessage(msg));
    // The SSE connection needs a beat before a push is routed to it.
    this.helloT = setTimeout(() => this.hello(), 60);
  }

  post(msg) {
    this.io.send(this.code, STATE_UID,
      JSON.stringify({ v: PROTO, from: this.uid, at: Date.now(), ...msg })).catch(() => {});
  }

  /** Ask whoever holds the tree for a snapshot; retried until one arrives. */
  hello() {
    this.connect();
    this.post({ op: 'hello' });
    if (this.tree || this.retries >= 10) return;
    this.retries++;
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => { if (!this.tree) this.hello(); }, 1000);
  }

  onMessage(raw) {
    let msg = raw;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } }
    if (!msg || msg.v !== PROTO || msg.from === this.uid) return;
    const at = msg.at || 0;
    switch (msg.op) {
      case 'hello':
        if (this.tree) this.post({ op: 'snapshot', tree: this.tree, rev: this.rev });
        break;
      case 'snapshot':
        // Only a tree we do not have (or a strictly newer one) replaces ours: a
        // member's own m/{uid} write must not be rolled back by a stale snapshot.
        if (!this.tree || at > this.rev) {
          this.tree = msg.tree ? clone(msg.tree) : null;
          this.rev = Math.max(this.rev, at);
          this.notify();
        }
        break;
      case 'set':
        this.tree = setIn(this.tree, msg.path || '', normalize(msg.value));
        this.rev = Math.max(this.rev, at);
        this.notify();
        break;
      case 'patch': {
        const obj = normalize(msg.value) || {};
        let tree = this.tree;
        for (const k of Object.keys(obj)) tree = setIn(tree, joinRel(msg.path, k), obj[k]);
        this.tree = tree;
        this.rev = Math.max(this.rev, at);
        this.notify();
        break;
      }
      default: break;
    }
  }

  notify() {
    for (const ref of [...this.subs]) ref._changed();
  }

  /** Local write: apply, publish, notify. */
  write(kind, rel, value) {
    // Whoever writes must also listen: the state channel is shared by every
    // participant of the room, and a writer that never subscribed could not
    // answer a newcomer's 'hello' with a snapshot.
    this.connect();
    if (kind === 'set') this.tree = setIn(this.tree, rel || '', normalize(value));
    else {
      const obj = normalize(value) || {};
      let tree = this.tree;
      for (const k of Object.keys(obj)) tree = setIn(tree, joinRel(rel, k), obj[k]);
      this.tree = tree;
    }
    this.rev = Date.now();
    this.notify();
    this.post(kind === 'set' ? { op: 'set', path: rel || '', value: normalize(value) }
      : { op: 'patch', path: rel || '', value: normalize(value) });
  }
}

const joinRel = (a, b) => (!a ? b : `${a}/${b}`);

// ---------------------------------------------------------------------------
// ref
// ---------------------------------------------------------------------------

class LocalRef {
  constructor(ctx, path, uid) {
    const m = /^rooms\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!m) throw new Error('signaling-local: unexpected ref path ' + path);
    this.path = path;
    this.uid = uid;
    this.code = m[1];
    this.rel = m[2] || '';
    this.isQueue = this.rel === 'q' || this.rel.startsWith('q/');
    this.handlers = [];
    this._link = null;
    this._es = null;
    this._ctx = ctx;
    this._flush = null;
  }

  get key() {
    const parts = this.path.split('/');
    return parts[parts.length - 1] || null;
  }

  get link() {
    if (!this._link) this._link = this._ctx.linkFor(this.code);
    return this._link;
  }

  child(name) { return new LocalRef(this._ctx, `${this.path}/${name}`, this.uid); }

  // ---- queue refs (net.mjs) ----
  _queueOn(cb) {
    if (this._es) return;
    const to = this.rel.split('/')[1];
    if (!to) return;
    this._es = this._ctx.io.open(this.code, to, (data) => {
      // Mirror the RTDB snapshot shape net.mjs's child_added callback expects.
      const raw = typeof data === 'string' ? data : (data && data.data);
      if (raw == null) return;
      cb({ val: () => raw, key: null, ref: { remove: () => Promise.resolve() } });
    });
  }

  // ---- room-state refs ----
  _node() { return getIn(this.link.tree, this.rel); }

  _snap(node) {
    return { val: () => clone(node ?? null), key: this.key, ref: this };
  }

  _changed() {
    const node = this._node();
    const cur = clone(node ?? null);
    for (const h of this.handlers) {
      try {
        if (h.event === 'value') {
          if (h.prev !== NEVER && same(cur, h.prev)) continue;
          h.prev = cur;
          h.cb(this._snap(node));
          continue;
        }
        const first = h.prev === NEVER;
        const p = first || !isObj(h.prev) ? {} : h.prev;
        const n = isObj(node) ? node : {};
        if (h.event === 'child_added') {
          for (const k of Object.keys(n)) if (!(k in p)) h.cb(this._childSnap(k, n[k]));
        } else if (h.event === 'child_changed') {
          for (const k of Object.keys(n)) if (k in p && !same(p[k], n[k])) h.cb(this._childSnap(k, n[k]));
        } else if (h.event === 'child_removed') {
          for (const k of Object.keys(p)) if (!(k in n)) h.cb(this._childSnap(k, p[k]));
        }
        h.prev = cur;
      } catch (e) { console.warn('[signaling-local] handler', e); }
    }
  }

  _childSnap(key, value) {
    return { key, val: () => clone(value ?? null), ref: this.child(key) };
  }

  on(event, cb) {
    if (event !== 'child_added' && event !== 'child_changed' && event !== 'child_removed' && event !== 'value') return;
    if (this.isQueue) { this._queueOn(cb); return; }
    // Firebase semantics: a listener's baseline is the tree at attach time, so
    // child_changed only reports changes that happen while it is attached.
    const known = this._node() !== undefined;
    const entry = { event, cb, prev: known ? clone(this._node() ?? null) : NEVER };
    this.handlers.push(entry);
    this.link.subs.add(this);
    this.link.hello();
    // child_added also fires for the children that already exist at attach time.
    if (!known || event === 'child_added' || event === 'value') {
      this._flush = setTimeout(() => { this._flush = null; this._changed(); }, 0);
    }
  }

  off() {
    this.handlers = [];
    if (this._es) { this._es.close(); this._es = null; }
    if (this._flush) { clearTimeout(this._flush); this._flush = null; }
    if (this._link) this._link.subs.delete(this);
  }

  once() {
    return new Promise((resolve) => {
      if (this.isQueue) { resolve(this._snap(null)); return; }
      if (this._node() != null) { resolve(this._snap(this._node())); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== entry);
        if (!this.handlers.length && this._link) this._link.subs.delete(this);
        resolve(this._snap(this._node()));
      };
      const entry = { event: 'value', cb: finish, prev: NEVER };
      // No answer means nobody holds that room (an empty tree), so a timeout is
      // the "room does not exist" answer, not an error.
      const timer = setTimeout(finish, 2000);
      this.handlers.push(entry);
      this.link.subs.add(this);
      this.link.hello();
    });
  }

  set(value) {
    if (this.isQueue) return this.push(value);
    this.link.write('set', this.rel, value);
    return Promise.resolve();
  }

  update(obj) {
    if (this.isQueue) return Promise.resolve();
    this.link.write('patch', this.rel, obj);
    return Promise.resolve();
  }

  remove() { return this.set(null); }

  push(value) {
    // Queue: deliver to the recipient. Any other path: append under a unique key.
    if (this.isQueue) {
      const to = this.rel.split('/')[1];
      if (!to) return Promise.resolve();
      return this.link.io.send(this.code, to, String(value)).catch(() => {});
    }
    const key = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return this.child(key).set(value);
  }
}
