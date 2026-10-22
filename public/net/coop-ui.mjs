// ============ coop-ui.mjs — minimal co-op room create/join panel ============
//
// A tiny, self-contained DOM panel that drives the Firebase room lifecycle and
// hands the session to the co-op bridge (globalThis.__pbStartCoop / __pbEnsureDb /
// __pbSetMembers defined in public/index.html). It is inert in single-player:
// nothing runs against the network until the user clicks "Create room" or
// "Join room" (or the page is loaded with ?room=CODE / ?coop=1).
//
// Room schema (matches firebase/database.rules.json):
//   rooms/{code}/{ host, open, at, m/{uid: {name,dex}}, q/{to}/{msg} }
//   - `host`  written once by the creator
//   - `open`/`at` host-only
//   - `m/{uid}` each member writes their own presence entry
//   - `q/{to}` net.mjs pushes signaling/relay messages to a recipient
//
// Free-tier safe: one room write on create, one presence write on join, and the
// signaling/relay messages only (net.mjs) — no per-tick RTDB writes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LEN = 6;
const DEFAULT_NAME = 'Player';
const DEFAULT_DEX = 1;

const state = { db: null, uid: null, code: null, host: null, isHost: false, members: new Map() };

const genCode = () => {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
};

const $ = (sel) => document.querySelector(sel);

async function ensureDb() {
  if (state.db) return state.db;
  const db = await globalThis.__pbEnsureDb();
  state.db = db;
  state.uid = db.uid;
  return db;
}

function status(msg, isErr) {
  const box = $('#pb-coop-status');
  if (!box) return;
  box.textContent = msg;
  box.classList.toggle('err', !!isErr);
}

// Publish our own member entry (name/dex). The bridge calls this at begin time,
// once the real species is known, so teammates render the right Pokémon. Only our
// own m/{uid} entry is written (rules key m/$uid writes off auth.uid).
globalThis.__pbPublishMembers = function (members) {
  if (!state.db || !state.code || !state.uid) return;
  const self = (members || []).find((m) => m.uid === state.uid);
  if (!self) return;
  state.db.rtdb.ref('rooms/' + state.code + '/m/' + state.uid)
    .update({ name: self.name, dex: self.dex })
    .catch(() => {});
};

// Keep the live member list (host needs it to open connections to new guests).
function watchMembers(roomRef) {
  const mref = roomRef.child('m');
  const upsert = (s) => {
    if (!s.key) return;
    const v = s.val() || {};
    state.members.set(s.key, { uid: s.key, name: v.name, dex: v.dex, shiny: !!v.shiny });
    globalThis.__pbSetMembers([...state.members.values()]);
  };
  mref.on('child_added', upsert);
  mref.on('child_changed', upsert);
  mref.on('child_removed', (s) => {
    if (s.key) {
      state.members.delete(s.key);
      globalThis.__pbSetMembers([...state.members.values()]);
    }
  });
}

function shareUrl(code) {
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  u.searchParams.delete('coop');
  return u.toString();
}

async function createRoom() {
  try {
    const db = await ensureDb();
    const code = genCode();
    const me = { uid: state.uid, name: DEFAULT_NAME, dex: DEFAULT_DEX, shiny: false };
    const roomRef = db.rtdb.ref('rooms/' + code);
    // `host` must exist before `open`/`at` (rules gate them on host == auth.uid).
    await roomRef.child('host').set(state.uid);
    await roomRef.update({
      open: true,
      at: db.ServerValue ? db.ServerValue.TIMESTAMP : Date.now(),
      ['m/' + state.uid]: { name: me.name, dex: me.dex },
    });
    state.code = code;
    state.isHost = true;
    state.host = state.uid;
    state.members.set(state.uid, me);
    watchMembers(roomRef);
    await globalThis.__pbStartCoop({
      room: code, host: state.uid, uid: state.uid,
      members: [...state.members.values()], seed: null,
    });
    status(`Room ${code} created — share the link to invite`);
    $('#pb-coop-code').value = code;
    history.replaceState(null, '', shareUrl(code));
  } catch (e) {
    status('Could not create room: ' + (e && e.message ? e.message : e), true);
    console.warn('[coop] create', e);
  }
}

async function joinRoom(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) { status('Enter a room code', true); return; }
  try {
    const db = await ensureDb();
    const roomRef = db.rtdb.ref('rooms/' + code);
    const snap = await roomRef.once('value');
    const room = snap.val();
    if (!room || room.open !== true) { status('Room not found or closed', true); return; }
    if (!room.host) { status('Room has no host', true); return; }
    const me = { uid: state.uid, name: DEFAULT_NAME, dex: DEFAULT_DEX, shiny: false };
    await roomRef.child('m').child(state.uid).set({ name: me.name, dex: me.dex });
    state.code = code;
    state.isHost = false;
    state.host = room.host;
    const mSnap = await roomRef.child('m').once('value');
    const m = mSnap.val() || {};
    state.members.clear();
    for (const [u, v] of Object.entries(m)) {
      state.members.set(u, { uid: u, name: v && v.name, dex: v && v.dex, shiny: !!(v && v.shiny) });
    }
    watchMembers(roomRef);
    await globalThis.__pbStartCoop({
      room: code, host: room.host, uid: state.uid,
      members: [...state.members.values()], seed: null,
    });
    status(`Joined room ${code}`);
    $('#pb-coop-code').value = code;
    history.replaceState(null, '', shareUrl(code));
  } catch (e) {
    status('Could not join room: ' + (e && e.message ? e.message : e), true);
    console.warn('[coop] join', e);
  }
}

function leaveRoom() {
  if (!state.db || !state.code) return;
  state.db.rtdb.ref('rooms/' + state.code + '/m/' + state.uid)
    .remove()
    .catch(() => {});
  // Net/Coop teardown is handled by net.mjs close(); a hard close here would
  // break the still-running single-player run, so we only drop presence.
  state.code = null;
  state.isHost = false;
  status('Left the room');
}

// ---------------------------------------------------------------- DOM ----

const CSS = `
#pb-coop-toggle {
  position: fixed; top: 12px; right: 12px; z-index: 2147483000;
  background: #1a1630; color: #ffcb3d; border: 1px solid #3a335c;
  border-radius: 8px; padding: 8px 12px; font: 700 13px/1 system-ui, sans-serif;
  cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.45);
}
#pb-coop-toggle:hover { border-color: #ffcb3d; }
#pb-coop-panel {
  position: fixed; top: 52px; right: 12px; z-index: 2147483000;
  width: 280px; background: #1a1630; color: #efeaff;
  border: 1px solid #3a335c; border-radius: 10px; padding: 14px;
  font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.55);
  display: none;
}
#pb-coop-panel.open { display: block; }
#pb-coop-panel h3 { margin: 0 0 10px; font-size: 15px; color: #ffcb3d; }
#pb-coop-panel button {
  display: block; width: 100%; margin: 6px 0; padding: 9px 10px;
  background: #2c2450; color: #fff; border: 1px solid #4a417a;
  border-radius: 7px; cursor: pointer; font: 700 13px/1 system-ui, sans-serif;
}
#pb-coop-panel button:hover { border-color: #ffcb3d; background: #352c5e; }
#pb-coop-panel input {
  width: 100%; box-sizing: border-box; padding: 8px 10px; margin: 4px 0;
  background: #120e24; color: #fff; border: 1px solid #4a417a; border-radius: 7px;
  font: 700 14px/1 monospace, monospace; text-transform: uppercase; letter-spacing: 2px;
}
#pb-coop-status { margin-top: 8px; color: #b9aef2; min-height: 16px; word-break: break-word; }
#pb-coop-status.err { color: #ff7a7a; }
`;

function injectPanel() {
  if (document.getElementById('pb-coop-toggle')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const toggle = document.createElement('button');
  toggle.id = 'pb-coop-toggle';
  toggle.textContent = 'CO-OP';
  toggle.title = 'Play co-op (create or join a room)';
  toggle.addEventListener('click', () => {
    const p = document.getElementById('pb-coop-panel');
    p.classList.toggle('open');
  });

  const panel = document.createElement('div');
  panel.id = 'pb-coop-panel';
  panel.innerHTML = `
    <h3>Co-op</h3>
    <button id="pb-coop-create">Create room</button>
    <input id="pb-coop-code" placeholder="ROOM CODE" maxlength="6" autocomplete="off" />
    <button id="pb-coop-join">Join room</button>
    <button id="pb-coop-copy">Copy link</button>
    <button id="pb-coop-leave">Leave room</button>
    <div id="pb-coop-status"></div>`;
  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  document.getElementById('pb-coop-create').addEventListener('click', createRoom);
  document.getElementById('pb-coop-join').addEventListener('click', () => joinRoom($('#pb-coop-code').value));
  document.getElementById('pb-coop-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom($('#pb-coop-code').value);
  });
  document.getElementById('pb-coop-copy').addEventListener('click', async () => {
    const code = $('#pb-coop-code').value;
    if (!code) { status('No room yet', true); return; }
    try {
      await navigator.clipboard.writeText(shareUrl(code));
      status('Copied');
    } catch (e) {
      status('Could not copy', true);
    }
  });
  document.getElementById('pb-coop-leave').addEventListener('click', leaveRoom);

  const show = () => panel.classList.add('open');
  const qs = new URL(location.href).searchParams;
  const room = qs.get('room');
  if (room) { show(); joinRoom(room); }
  else if (qs.has('coop') && qs.get('coop') !== 'local') show();
}

globalThis.__pbCoopUI = { create: createRoom, join: joinRoom, leave: leaveRoom, show: () => $('#pb-coop-panel')?.classList.add('open') };

// Mount once the bridge globals exist (coop-ui is dynamically imported from the
// bridge, so they do); render the panel immediately for ?room= / ?coop=1.
if (globalThis.__pbStartCoop) injectPanel();
else console.warn('[coop] bridge globals missing — panel not mounted');
