// net/coop-boot-0.8.29.mjs — Bootstrap co-op layer for the 0.8.29 build.
//
// Wires the upstream session (GT) and its WebRTC ctl channel with the fork's
// party-wide level barrier and shared pickup/gold sync.

import { installBridge } from './coop-bridge-0.8.29.mjs';
import { ctlTransport, roomSignalTransport } from './coop-ctl-0.8.29.mjs';

/**
 * Bootstraps co-op on an active run and session.
 *
 * @param {object} opts
 * @param {object} opts.coop      The upstream GT session instance.
 * @param {object} opts.store     The pickup store (game's `sm` manager).
 * @param {object} [opts.run]     The current game run.
 * @param {string[]} [opts.members] Party members UIDs.
 * @param {string} [opts.me]      Local player UID.
 * @param {boolean|string} [opts.host] True if local client is host (or host UID string).
 * @param {(uid: string) => string} [opts.nameOf] UID to player name resolver.
 * @param {object} [opts.target]  Global target to receive the bridge (default globalThis).
 */
export function bootCoop(opts = {}) {
  if (!opts || !opts.coop) throw new Error('coop session is required');
  if (!opts.store) throw new Error('pickup store is required');

  const { coop, store, run, me, nameOf, target } = opts;

  // 1. Install bridge if missing on target (defaults to globalThis)
  const env = target || globalThis;
  let bridge = env.__pbCoop;
  if (!bridge) {
    bridge = installBridge({ target: env });
  }

  // Derive host, me, members
  const isHost = typeof opts.host === 'boolean'
    ? opts.host
    : (opts.host ? false : (coop.isHost ?? false));
  const myUid = me ?? coop.me ?? coop.room?.me ?? 'local';
  const members = opts.members ?? coop.room?.members?.map((m) => m.id) ?? (isHost ? [myUid] : []);
  const nameResolver = nameOf ?? ((uid) => coop.room?.members?.find((m) => m.id === uid)?.name ?? uid);

  // Derive hostId in order: explicit host string/opts.hostId -> coop.room.room.host -> coop.room.host -> coop.hostId
  const explicitHost = (typeof opts.host === 'string' && opts.host) || opts.hostId || null;
  const hostId = explicitHost
    ?? coop.room?.room?.host
    ?? coop.room?.host
    ?? coop.hostId;

  if (hostId) {
    coop.hostId = hostId;
  }

  // 2. Build transport (with room signaling relay fallback if mesh cannot be built)
  let transport;
  let isRelay = false;
  try {
    transport = ctlTransport(coop, null, { hostId });
  } catch (err) {
    if (opts.relay && typeof opts.relay.signal === 'function') {
      transport = roomSignalTransport(coop, {
        signal: opts.relay.signal,
        poll: opts.relay.poll,
        intervalMs: opts.relay.intervalMs,
        hostId,
        me: myUid,
      });
      isRelay = true;
    } else {
      throw err;
    }
  }

  bridge.isRelay = () => isRelay;
  // 3. Attach session
  bridge.attachSession({
    host: isHost,
    me: myUid,
    members,
    send: transport.send,
    nameOf: nameResolver,
  });

  // 4. Attach pickups
  bridge.attachPickups({
    store,
    run: run || null,
  });

  // 5. Bind run
  if (run) {
    bridge.bind(run);
  }

  // Attach projectiles replication if available
  if (run?.projectiles && typeof bridge.attachShots === 'function') {
    bridge.attachShots({
      projectiles: run.projectiles,
      run,
    });
  }

  // 6. Wire receive so incoming ctl messages reach bridge.receive(ev, from)
  const innerReceive = bridge.receive.bind(bridge);
  transport.onReceive = (ev, from) => {
    innerReceive(ev, from);
  };

  bridge.receive = (msg, from) => {
    return transport.receive(msg, from);
  };

  // If coop exposes an onCtl hook (e.g. fake coop in tests), wire it as well
  if (typeof coop.onCtl === 'function') {
    const origOnCtl = coop.onCtl.bind(coop);
    coop.onCtl = (e, t) => {
      if (t && t.t === 'pb') {
        bridge.receive(t, e);
        return;
      }
      return origOnCtl(e, t);
    };
  }

  return { bridge, transport };
}

/**
 * Returns summary diagnostic info about the installed co-op state.
 *
 * @param {object} [target=globalThis]
 * @returns {{ installed: boolean, guest: boolean, pickups: boolean }}
 */
export function bootInfo(target = globalThis) {
  const bridge = (target || globalThis).__pbCoop;
  return {
    installed: !!bridge,
    guest: !!bridge?.isGuest(),
    pickups: !!bridge?.pickupsActive(),
    relay: !!bridge?.isRelay?.(),
  };
}
