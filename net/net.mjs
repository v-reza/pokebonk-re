// ============ net.mjs — WebRTC + RTDB signaling between room players ============
// Star topology: the HOST talks to each guest; guests only talk to the host (it
// forwards whatever is needed).
//
// Two paths, in parallel:
//   direct  WebRTC (browser-to-browser data channel). Signaling (SDP/ICE) goes
//           through the Realtime Database. STUN is used; TURN is OFF here.
//   relay   messages go through the Realtime Database: rooms/{room}/q/{to}/{id}.
//
// Sends on the direct channel when open, otherwise via the relay. The receiver
// listens on both, so no agreement is needed.
//
// Ported from pokesurvivor/js/net/net.js (G.Net) as an ES module. The module no
// longer reads G.DB.fb / G.NetCodec globals; call init(db, uid) first where db is
// { rtdb, uid, auth?, emulator? }.
//
// API: init(db, uid) · open(roomId, isHost, hostUid) · close() · send(to, msg)
//      toHost(msg) · broadcast(msg, except) · on(fn(from, msg))
//      onPeer(fn(uid, mode)) · peers() · mode(uid) -> 'connecting'|'direct'|'relay'|'closed'

import { version as CODEC_VERSION, encode, decode, size } from './codec.mjs';

const ICE = [{ urls: [
  'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302',
  // A second provider: Google's STUN is unreachable on some networks, and a
  // failed reflexive candidate sends the whole match to the 3 Hz relay.
  'stun:stun.cloudflare.com:3478',
] }];
const TURN_API = 'https://ice.pokesurvivor.com/v1/ice';
// No TURN. Play over STUN and, if it fails, through the database.
const TURN_ON = false;
// Try without TURN first (direct is the normal case) and only retry with it if it
// fails: the browser reserves a TURN slot per connection that carries it, even if
// it later goes direct, so slots run out for everyone.
const DIRECT_TIMEOUT = 9000, TURN_TIMEOUT = 15000;   // ms to get a channel
// Relay through the Realtime Database: ON here (deliverable requires ALLOW_RELAY).
const ALLOW_RELAY = true, RETRY_MS = 15000;
// While the game continues on the database relay, keep trying to get the direct
// channel: a relayed session is 3 frames/s, and the first ICE attempt can lose to
// a slow access point, a NAT rebind or a late candidate. Only the host dials.
const DIRECT_RETRY_MS = 15000, DIRECT_RETRY_FAST_MS = 4000;

export const CONSTANTS = { ICE, TURN_API, TURN_ON, DIRECT_TIMEOUT, TURN_TIMEOUT, ALLOW_RELAY, RETRY_MS };

let fb = null;                 // db handle: { rtdb, uid, auth?, emulator? }
let uid = null;
let roomId = null, isHost = false, hostUid = null;
let qref = null;
let rtdb = null;
const peers = new Map();       // uid -> { pc, dc, mode, timer }
// Host: guests with whom the direct path already failed. Remembered for the whole
// session (not just the room) so the TURN-less wait isn't lost twice.
const needTurn = new Set();
const handlers = new Set(), peerHandlers = new Set();
const stats = { sent: 0, recv: 0, relaySent: 0,
  // Only game data that was actually sent (no ICE/SCTP/DTLS/TURN).
  sentBytes: 0, jsonBytes: 0, recvBytes: 0, binarySent: 0, binaryRecv: 0, invalidBinary: 0 };

// ---------------- TURN ----------------
// Kept for parity with the reference; TURN_ON is false, so these never fire.
let turn = null, turnUid = null, turnAsk = null, turnRetry = 0;

function cleanIce(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4).map(s => ({
    urls: (Array.isArray(s && s.urls) ? s.urls : []).filter(x => typeof x === 'string' &&
      /^turns?:turn\.pokesurvivor\.com:\d{2,5}(\?transport=(udp|tcp))?$/.test(x)).slice(0, 4),
    username: String(s && s.username || '').slice(0, 200),
    credential: String(s && s.credential || '').slice(0, 200)
  })).filter(s => s.urls.length && s.username && s.credential);
}

function turnUser() {
  const f = fb, user = f && !f.emulator && f.auth && f.auth.currentUser;
  return user && !user.isAnonymous ? user : null;
}

/** What is already known without asking: the list (possibly empty) or null to fetch. */
function turnNow() {
  if (!TURN_ON) return [];
  const user = turnUser();
  if (!user) return [];
  if (turn && turnUid === user.uid && turn.expiresAt * 1000 - Date.now() > 600000) return turn.iceServers;
  return Date.now() < turnRetry ? [] : null;
}

function turnServers() {
  const now = turnNow(), user = turnUser();
  if (now) return Promise.resolve(now);
  if (!turnAsk) {
    turnAsk = (async () => {
      const ctl = new AbortController(), stop = setTimeout(() => ctl.abort(), 4000);
      try {
        const token = await user.getIdToken();
        const r = await fetch(TURN_API, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
        if (!r.ok) { turnRetry = Date.now() + (r.status === 403 ? 1800000 : 60000); return; }
        const j = await r.json(), iceServers = cleanIce(j && j.iceServers);
        if (!iceServers.length || !(j.expiresAt * 1000 > Date.now())) { turnRetry = Date.now() + 60000; return; }
        turn = { iceServers, expiresAt: j.expiresAt }; turnUid = user.uid;
      } catch (e) { turnRetry = Date.now() + 60000; }
      finally { clearTimeout(stop); turnAsk = null; }
    })();
  }
  return turnAsk.then(() => turn && turnUid === user.uid ? turn.iceServers : []);
}

/** Did the connection with u end up going through TURN? (for the room UI) */
async function checkTurn(u, p) {
  try {
    const st = await p.pc.getStats();
    let pair = null;
    st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
    if (!pair) st.forEach(r => { if (!pair && r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const local = pair && st.get(pair.localCandidateId), remote = pair && st.get(pair.remoteCandidateId);
    const via = !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'));
    if (via !== !!p.viaTurn && peers.get(u) === p) { p.viaTurn = via; emitPeer(u); }
  } catch (e) { /* only for the room text */ }
}

function emitPeer(u) {
  const p = peers.get(u);
  peerHandlers.forEach(fn => { try { fn(u, p ? p.mode : 'closed'); } catch (e) { console.warn(e); } });
}

// ---------------- init / open ----------------

/**
 * Bind the network module to a database handle and the local uid.
 * @param db   { rtdb, uid, auth?, emulator? }  (auth/emulator only needed for TURN, which is off)
 * @param myUid the local player uid (may also come from db.uid)
 */
function init(db, myUid) {
  fb = db;
  uid = myUid ?? db.uid;
}

function open(id, host, hostId) {
  if (roomId === id) return;
  close();
  rtdb = fb.rtdb; uid = uid ?? fb.uid;
  roomId = id; isHost = host; hostUid = hostId;
  qref = rtdb.ref('rooms/' + id + '/q/' + uid);
  qref.on('child_added', s => {
    const raw = s.val();
    s.ref.remove().catch(() => {});
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || !m.f) return;
    if (m.sig) onSignal(m.f, m.sig);
    else deliver(m.f, m.d);
  });
  // Guest: a slot for the host right away (replaced when its offer arrives). If it
  // never does, continue via relay and know when it leaves.
  if (!isHost) {
    const p = { pc: null, dc: null, mode: 'connecting', timer: 0 };
    p.timer = setTimeout(() => { if (p.mode === 'connecting') { p.mode = ALLOW_RELAY ? 'relay' : 'failed'; emitPeer(hostId); } }, DIRECT_TIMEOUT + (TURN_ON ? TURN_TIMEOUT : 0) + 3000);
    peers.set(hostId, p);
  }
}

function close() {
  for (const u of [...peers.keys()]) drop(u);
  if (qref) { qref.off(); qref = null; }
  roomId = null; isHost = false; hostUid = null;
}

const turnFirst = u => needTurn.has(u) || needTurn.size >= 2;

/** The host calls this when room members change. */
function syncMembers(uids) {
  if (!roomId) return;
  if (isHost) {
    for (const u of uids) if (u !== uid && !peers.has(u)) connect(u);
    for (const u of [...peers.keys()]) if (!uids.includes(u)) drop(u);
  } else if (!uids.includes(hostUid)) {
    drop(hostUid);
  }
}

// ---------------- WebRTC ----------------

function newPeer(u, turnIce) {
  const p = { pc: null, dc: null, mode: 'connecting', timer: 0, viaTurn: false, turn: !!(turnIce && turnIce.length) };
  peers.set(u, p);
  // Without WebRTC (old/blocked browser): straight to relay.
  let pc;
  try { pc = p.pc = new RTCPeerConnection({ iceServers: ICE.concat(turnIce || []) }); }
  catch (e) { p.mode = 'relay'; emitPeer(u); return p; }
  pc.onicecandidate = e => { if (e.candidate) signal(u, { c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && p.mode !== 'closed') useRelay(u);
  };
  // If no direct channel within a few seconds, continue via relay.
  p.timer = setTimeout(() => { if (p.mode === 'connecting') useRelay(u); }, p.turn ? TURN_TIMEOUT : DIRECT_TIMEOUT);
  emitPeer(u);
  return p;
}

function wireChannel(u, p, dc) {
  p.dc = dc;
  p.binaryVersion = 0;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    clearTimeout(p.timer);
    clearTimeout(p.retry);
    p.retry = 0;
    p.mode = 'direct';
    if (p.pc) checkTurn(u, p);
    // Announce we understand binary (older versions ignore it); until the other end
    // sends its own, we speak JSON.
    try { dc.send(JSON.stringify({ k: 'net-cap', binary: CODEC_VERSION })); } catch (e) { /* JSON still works */ }
    emitPeer(u);
  };
  dc.onclose = () => { if (p.mode === 'direct') { p.mode = 'connecting'; useRelay(u); } };
  dc.onmessage = e => {
    let m;
    if (typeof e.data === 'string') {
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m && m.k === 'net-cap') {
        p.binaryVersion = m.binary === CODEC_VERSION ? m.binary : 0;
        return;
      }
      stats.recvBytes += size(e.data);
    } else {
      try {
        if (p.binaryVersion !== CODEC_VERSION) throw Error('unnegotiated binary');
        m = decode(e.data);
        if (!m || m.k !== 'f') throw Error('not a frame');
      } catch (err) { stats.invalidBinary++; return; }
      stats.recvBytes += e.data.byteLength; stats.binaryRecv++;
    }
    deliver(u, m);
  };
}

function useRelay(u) {
  const p = peers.get(u);
  if (!p || p.mode === 'closed' || p.mode === 'failed') return;
  if (p.mode === 'relay') { retryDirect(u, p); return; }
  const wasDirect = p.mode === 'direct';
  if (wasDirect) {
    // The direct channel died mid-session. Kill only the WebRTC side: the peer
    // entry (and the database relay) keep the game running while we redial.
    p.dc = null;
    try { if (p.pc) p.pc.close(); } catch (e) { /* nothing */ }
    p.pc = null;
  }
  if (ALLOW_RELAY) {
    p.mode = 'relay';
    emitPeer(u);
    retryDirect(u, p, wasDirect ? DIRECT_RETRY_FAST_MS : DIRECT_RETRY_MS);
    return;
  }
  // No relay: cannot play with that person for now. The host retries.
  clearTimeout(p.timer);
  p.mode = 'failed';
  try { if (p.pc) p.pc.close(); } catch (e) { /* nothing */ }
  emitPeer(u);
  if (!isHost) return;
  const withTurn = !p.turn && !needTurn.has(u) && !!turnUser();
  if (withTurn) needTurn.add(u);
  p.timer = setTimeout(() => { if (peers.get(u) === p && p.mode === 'failed' && roomId) { drop(u, true); connect(u); } }, withTurn ? 0 : RETRY_MS);
}

/**
 * Host only, while the relay keeps the game alive: drop the failed WebRTC peer
 * and dial again. `drop(u, true)` is silent, so the lobby does not flash through
 * "connecting"; the relay carries the frames in between.
 */
function retryDirect(u, p, delay = DIRECT_RETRY_MS) {
  if (!isHost || !ALLOW_RELAY || !roomId || p.mode === 'direct') return;
  if (p.retry) return;
  p.retry = setTimeout(() => {
    p.retry = 0;
    if (peers.get(u) !== p || !roomId || p.mode === 'direct') return;
    drop(u, true);
    connect(u);
  }, delay);
}

/** Host: open a connection to a guest. */
async function connect(u) {
  if (!roomId || peers.has(u)) return;
  let turnIce = turnFirst(u) ? turnNow() : [];
  if (!turnIce) {
    const room = roomId; turnIce = await turnServers();
    if (roomId !== room || peers.has(u)) return;
  }
  const p = newPeer(u, turnIce);
  if (!p.pc) return;
  wireChannel(u, p, p.pc.createDataChannel('g', { ordered: true }));
  try {
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    signal(u, p.turn ? { sdp: p.pc.localDescription.toJSON(), t: 1 } : { sdp: p.pc.localDescription.toJSON() });
  } catch (e) { useRelay(u); }
}

const pendingIce = new Map();     // candidates arriving before the offer

async function onSignal(from, sig) {
  let p = peers.get(from);
  try {
    if (sig.sdp && sig.sdp.type === 'offer') {
      if (isHost) return;
      let turnIce = sig.t ? turnNow() : [];
      if (!turnIce) {
        const room = roomId; turnIce = await turnServers();
        if (roomId !== room) return;
        p = peers.get(from);
      }
      if (p) drop(from, true);
      p = newPeer(from, turnIce);
      if (!p.pc) return;
      p.pc.ondatachannel = e => wireChannel(from, p, e.channel);
      await p.pc.setRemoteDescription(sig.sdp);
      const ans = await p.pc.createAnswer();
      await p.pc.setLocalDescription(ans);
      signal(from, { sdp: p.pc.localDescription.toJSON() });
      for (const c of pendingIce.get(from) || []) await p.pc.addIceCandidate(c).catch(() => {});
      pendingIce.delete(from);
    } else if (sig.sdp && sig.sdp.type === 'answer') {
      if (p && p.pc) await p.pc.setRemoteDescription(sig.sdp);
    } else if (sig.c) {
      if (p && p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(sig.c).catch(() => {});
      else { if (!pendingIce.has(from)) pendingIce.set(from, []); pendingIce.get(from).push(sig.c); }
    }
  } catch (e) {
    console.warn('[Net] signaling:', e.message);
    useRelay(from);
  }
}

function signal(to, sig) { relayPush(to, { f: uid, sig }); }

function drop(u, silent) {
  const p = peers.get(u);
  if (!p) return;
  clearTimeout(p.timer);
  clearTimeout(p.retry);
  p.retry = 0;
  p.mode = 'closed';
  try { if (p.dc) p.dc.close(); } catch (e) { /* nothing */ }
  try { if (p.pc) p.pc.close(); } catch (e) { /* nothing */ }
  peers.delete(u);
  if (!silent) emitPeer(u);
}

// ---------------- send / receive ----------------

function relayPush(to, env) {
  if (!rtdb || !roomId) return;
  rtdb.ref('rooms/' + roomId + '/q/' + to).push(JSON.stringify(env)).catch(e => console.warn('[Net] relay:', e.code || e.message));
}

function send(to, msg) {
  if (!roomId) return;
  const p = peers.get(to);
  stats.sent++;
  if (p && p.dc && p.dc.readyState === 'open') {
    try {
      // Binary was negotiated: send frames as binary without also building the
      // JSON just to compare sizes (that doubled the cost of every frame; the
      // JSON is only made if the frame cannot be encoded).
      const packed = p.binaryVersion === CODEC_VERSION && msg && msg.k === 'f'
        ? encode(msg) : null;
      if (packed) {
        p.dc.send(packed);
        stats.sentBytes += packed.byteLength;
        stats.binarySent++;
        return;
      }
      const json = JSON.stringify(msg), jsonBytes = size(json);
      p.dc.send(json);
      stats.sentBytes += jsonBytes;
      stats.jsonBytes += jsonBytes;
      return;
    } catch (e) { /* falls through to relay */ }
  }
  // Without relay, game data does not go through the database (lost: that pair is
  // not connected). Only the start notice passes.
  if (!ALLOW_RELAY && !(msg && msg.k === 'start')) return;
  stats.relaySent++;
  relayPush(to, { f: uid, d: msg });
}

function toHost(msg) { if (!isHost && hostUid) send(hostUid, msg); }
function broadcast(msg, except) { for (const u of peers.keys()) if (u !== except) send(u, msg); }

function deliver(from, msg) {
  stats.recv++;
  handlers.forEach(fn => { try { fn(from, msg); } catch (e) { console.error('[Net] message:', e); } });
}

// ---------------- public API ----------------

export {
  init, open, close, syncMembers, send, toHost, broadcast,
  on, off, onPeer, mode, viaTurn, slow, peerUids,
  isOpen, isHostNow, getUid, getHostUid, stats
};

function on(fn) { handlers.add(fn); }
function off(fn) { handlers.delete(fn); }
function onPeer(fn) { peerHandlers.add(fn); }
function mode(u) { const p = peers.get(u); return p ? p.mode : 'closed'; }
function viaTurn(u) { const p = peers.get(u); return !!(p && p.mode === 'direct' && p.viaTurn); }
function slow(u) { const p = peers.get(u); return !p || p.mode !== 'direct'; }
function peerUids() { return [...peers.keys()]; }
function isOpen() { return !!roomId; }
function isHostNow() { return isHost; }
function getUid() { return uid; }
function getHostUid() { return hostUid; }
