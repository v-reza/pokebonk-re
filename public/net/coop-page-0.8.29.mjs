// public/net/coop-page-0.8.29.mjs — page bootstrap for the 0.8.29 co-op bridge.
//
// Installs `__pbCoop`, boots the session when a run with `run.coop` exists, and
// supervises the transport: if the WebRTC mesh never opens a peer link (strict
// NAT, blocked UDP), it falls back to the room-signal relay the server already
// provides, so the party keeps playing at a lower rate instead of dropping.
import { installBridge } from './coop-bridge-0.8.29.mjs';
import { bootCoop } from './coop-boot-0.8.29.mjs';
import { roomSignalTransport } from './coop-ctl-0.8.29.mjs';

let booted = false;
let waitingLogged = false;
let relay = null;
let watchdog = null;

globalThis.__pbCoopBoot = globalThis.__pbCoopBoot || {
  attempts: 0, booted: false, lastError: null, relay: false,
};

const sessionToken = () => {
  try {
    const raw = localStorage.getItem('pb.session');
    const s = raw ? JSON.parse(raw) : null;
    return s && s.token ? s.token : null;
  } catch {
    return null;
  }
};

const roomCode = (coop) => coop?.room?.code ?? coop?.room?.room?.code ?? null;

function linksOpen(coop) {
  const peers = coop?.peers;
  if (!peers || typeof peers.values !== 'function') return false;
  for (const p of peers.values()) if (p && p.link === 'open') return true;
  return false;
}

function startRelay(coop) {
  if (relay) return relay;
  const code = roomCode(coop);
  const token = sessionToken();
  if (!code || !token) return null;

  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  relay = roomSignalTransport(coop, {
    hostId: coop?.room?.room?.host ?? coop?.room?.host ?? coop?.hostId ?? null,
    me: coop?.room?.me ?? null,
    intervalMs: 400,
    signal: (to, kind, data) => {
      void fetch(`/api/coop/rooms/${code}/signal`, {
        method: 'POST', headers: auth, body: JSON.stringify({ to, kind, data }),
      }).catch(() => {});
    },
    poll: async (after) => {
      const r = await fetch(`/api/coop/rooms/${code}?after=${after}`, { headers: auth });
      return r.ok ? r.json() : null;
    },
  });
  relay.onMessage = (ev, from) => {
    const bridge = globalThis.__pbCoop;
    if (bridge) bridge.receive(ev, from);
  };
  globalThis.__pbCoopBoot.relay = true;
  console.info('[pbcoop] relay fallback engaged for room', code);
  return relay;
}

/**
 * Lobby readiness: upstream disables Start until the WebRTC mesh is up, which
 * never happens on networks that block direct connections. Our relay works over
 * plain HTTP, so a successful room poll is enough to say the party is reachable.
 */
function watchRoom() {
  if (watchdog === 'room') return;
  watchdog = 'room';
  setInterval(async () => {
    // the token appears only after the guest login, so read it per tick
    const token = sessionToken();
    const m = document.body?.innerText?.match(/Room\s+([A-Z0-9]{4})\b/);
    const bridge = globalThis.__pbCoop;
    if (!token || !m || !bridge || typeof bridge.setRoomReady !== 'function') return;
    try {
      const r = await fetch(`/api/coop/rooms/${m[1]}?after=0`, { headers: { authorization: 'Bearer ' + token } });
      bridge.setRoomReady(r.ok);
    } catch {
      bridge.setRoomReady(false);
    }
  }, 1500);
}

function tryBoot() {
  if (booted) return;
  const st = globalThis.__pbCoopBoot;
  st.attempts++;
  try {
    const run = globalThis.__pb?.run;
    const coop = run?.coop;
    const store = run?.pickups;

    if (!(run && coop && store)) {
      if (!waitingLogged) {
        waitingLogged = true;
        console.info('[pbcoop] waiting for run/session');
      }
      return;
    }

    const bridge = bootCoop({ coop, run, store });
    booted = true;
    st.booted = true;
    console.info('[pbcoop] co-op booted for run');

    // supervise the transport: mesh first, relay if a link never opens
    let waited = 0;
    watchdog = setInterval(() => {
      waited += 1000;
      if (linksOpen(coop)) return;
      if (waited < 8000) return;
      const t = startRelay(coop);
      if (t) globalThis.__pbCoop.useTransport(t.send);
      if (waited > 30000) clearInterval(watchdog);
    }, 1000);
    void bridge;
  } catch (err) {
    st.lastError = String((err && err.message) || err);
    console.warn('[pbcoop] boot attempt failed:', err);
  }
}

export function install() {
  const urlParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const pbcoopParam = urlParams?.has('pbcoop') && urlParams.get('pbcoop') === '1';

  if (globalThis.__PB_COOP_AUTOLOAD__ === false && !pbcoopParam) return;

  if (!globalThis.__pbCoop) installBridge();
  tryBoot();
  watchRoom();

  if (!booted && typeof window !== 'undefined') {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      tryBoot();
      if (booted || attempts > 240) clearInterval(timer);
    }, 1000);
  }
}

install();
