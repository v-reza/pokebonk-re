// ============ coop-ui.mjs — in-game Friends / Lobby / Invite screens ============
//
// The co-op flow lives INSIDE the game's own UI layer, not in a floating panel:
//
//   Friends screen  → add by name, accept/decline requests, invite, create room
//   Lobby screen    → room code, member cards with sprites, host invites + Start
//   Invite popup    → modal over whatever screen is open ("X te invita…")
//
// How it hooks into the bundle: `public/index.html` dynamically imports this file
// after defining the bridge globals (`__pbStartCoop`, `__pbEnsureDb`,
// `__pbSetMembers`, `__pbSetMembers`, `__pbNet`, `__pb`). The bundle does not
// export its screen system, so the screens are rendered with the game's own CSS
// classes (`.screen.dim.blur`, `.scr-head`, `.scr-title`, `.panel`, `.btn`,
// `.fr-row`, …) and appended to `#ui` — the same container `MM.setScreen()` uses.
// They are pushed in FRONT of the current screen and re-mounted if the bundle
// replaces `#ui` content underneath them.
//
// Networking: the REST API under /api (same origin). Presence/friends/invites are
// polled every 2.5 s while a social screen is open (or an invite is pending), and
// every 15 s otherwise. Signaling still goes through net/net.mjs + the local relay;
// nothing here talks to Firebase.
//
// Room schema (server: firebase/social.mjs):
//   { code, host, open, started, seed, at, members:[{uid,name,dex,shiny,at}] }

const API = '/api';
const POLL_OPEN = 2500;      // ms while a social screen is open
const POLL_IDLE = 15000;     // ms while only listening for invites
const NAME_MAX = 24;

const state = {
  token: null,
  me: null,                 // { id, name, guest }
  friends: null,            // last GET /friends payload
  room: null,               // last room payload (we are a member)
  invite: null,             // the invite currently shown in the popup
  seen: new Set(),          // invite keys already dismissed (from|at)
  screen: null,             // 'friends' | 'lobby' | null
  msg: { text: '', bad: false },
  addName: '',
  suggest: [],
  pollTimer: 0,
  busy: false,
  starting: false,
  mounted: null,            // the element we appended to #ui
  el: {},                   // cached nodes for in-place updates
  roomMiss: 0,              // consecutive /friends polls without our room
  membersKey: '',           // last member list handed to the net layer
  pendingRun: null,         // a started room we did NOT auto-enter (host start)
  lobbyBaseline: undefined, // 'code:seed' already seen when the lobby opened
  finishedRunKey: null,     // 'code:seed' this tab already played to the end
  rosterRetry: false,
  rosterTries: 0,
};

// ------------------------------------------------------------- tiny helpers ---

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

// Co-op UI screens and notices are rendered in English.

/** Pokémon sprite: the mirrored `icons/{dex}.png` (the bundle's `Vx()` source). */
const sprite = (dex, cls = 'pix') => {
  const id = Number(dex) || 1;
  const img = h('img', {
    class: cls, src: `/assets/icons/${id}.png`, alt: '', draggable: 'false', loading: 'lazy',
  });
  // Same fallback the bundle uses: missing icon -> the portrait, then sprite 1.
  img.addEventListener('error', () => {
    if (img.dataset.fb === '2') { img.src = '/assets/icons/1.png'; img.dataset.fb = '3'; return; }
    if (img.dataset.fb === '1') { img.dataset.fb = '2'; img.src = `/assets/front/${id}.png`; return; }
    if (!img.dataset.fb) { img.dataset.fb = '1'; img.src = `/assets/portraits/${id}.png`; }
  });
  return img;
};

// ------------------------------------------------------------------- session ---

/** The game stores its session as `pb.session` (JSON) in localStorage. */
function readSession() {
  try {
    const v = JSON.parse(localStorage.getItem('pb.session') || 'null');
    if (v && v.token && v.id && v.name) return v;
  } catch { /* corrupt entry: treat as signed out */ }
  return null;
}

function sessionChanged() {
  const s = readSession();
  // Only a switch from one account to ANOTHER resets the co-op state. This
  // module loads before the player signs in, so the first sign-in used to count
  // as a change and wiped the room a just-accepted invite had put us in.
  const changed = !!state.me && (s && s.id) !== state.me.id;
  state.token = s ? s.token : null;
  state.me = s ? { id: s.id, name: s.name, guest: !!s.guest } : null;
  if (changed) {
    state.friends = null; state.room = null; state.invite = null; state.seen.clear();
    state.screen = null;
    unmount();
  }
  return !!s;
}

async function api(method, path, body) {
  if (!state.token) throw Object.assign(new Error('Sign in to play with friends.'), { status: 401 });
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${state.token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = res.status === 204 ? null : await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Could not connect to the server.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * The starter the player has selected. The save is server-side (`meta.profile`),
 * there is no `pb.save` key: reading it gave 0 for everyone, so the lobby showed
 * Bulbasaur for every member and teammates fell back to the local starter.
 * `__pbApp` is exposed by bundle patch A16.
 */
const myDex = () => {
  const app = globalThis.__pbApp;
  const run = globalThis.__pb && globalThis.__pb.run;
  return (run && run.player && run.player.speciesId) ||
    (app && app.meta && app.meta.profile && app.meta.profile.lastSpecies) || 0;
};

// --------------------------------------------------------- run-follow intent ---
// A room stays `started` forever (the lobby is reused for one run), so a client
// that merely IS a member must not launch into that run on its own: that is the
// "I did nothing and the game suddenly started" report. Two explicit signals
// allow it:
//   1. the start happens WHILE the lobby is open (the host pressed Start), or
//   2. this tab was in that run and reloaded (a short-lived intent in storage).
const FOLLOW_KEY = 'pb.coop.follow';
const FOLLOW_TTL = 30 * 60 * 1000;
const runKeyOf = (room, seed) => (room && seed != null ? `${room.code}:${seed}` : null);

function followIntent() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLLOW_KEY) || 'null');
    if (v && v.code && Number.isFinite(v.seed) && Date.now() - (v.at || 0) < FOLLOW_TTL) return v;
  } catch { /* corrupt entry */ }
  return null;
}

function intentMatches(room, seed) {
  const v = followIntent();
  return !!(v && room && v.code === room.code && v.seed === seed);
}

function rememberFollow(room, seed) {
  try { localStorage.setItem(FOLLOW_KEY, JSON.stringify({ code: room.code, seed, at: Date.now() })); } catch { /* private mode */ }
}

function forgetFollow() {
  try { localStorage.removeItem(FOLLOW_KEY); } catch { /* private mode */ }
}

/**
 * Host: keep the net layer's peer set equal to the room while it is open. Doing
 * this only at run start left the guests on the database relay (3 frames/s) for
 * the first 10-15 s of every game, because the WebRTC handshake started then.
 * Pushing the member list from the lobby poll warms the direct channel up first.
 */
function syncRoomMembers(room) {
  // The lobby warms the channel up; during a run the Coop session owns the
  // peers (and re-dialing a guest the run already declared gone would be noise).
  if (state.screen !== 'lobby') return;
  const members = (room.members || []).map((m) => ({
    uid: m.uid, name: m.name, dex: m.dex | 0, shiny: !!m.shiny,
  }));
  const key = room.code + '|' + members.map((m) => m.uid).join(',');
  const net = globalThis.__pbNet;
  const me = state.me && state.me.id;
  // The list may be unchanged while the net layer only just opened (the
  // Firebase SDK load can outlive the first polls), so "same list" alone is not
  // enough: make sure every other member actually has a peer.
  const pending = net && net.isHostNow && net.isHostNow() && net.isOpen && net.isOpen()
    ? members.some((m) => m.uid !== me && !net.peerUids().includes(m.uid))
    : false;
  if (key === state.membersKey && !pending) return;
  state.membersKey = key;
  if (globalThis.__pbSetMembers) globalThis.__pbSetMembers(members);
}

// ------------------------------------------------------------------ polling ---

function startPolling() {
  if (state.pollTimer) return;
  // One code path for the timer and for the explicit refresh, so a guest never
  // misses the host's start just because only one of them handled it.
  state.pollTimer = setInterval(() => { poll(); }, state.screen ? POLL_OPEN : POLL_IDLE);
  poll();
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

/** Re-arm the interval with the cadence the current screen needs. */
function retime() {
  if (!state.pollTimer) return;
  stopPolling();
  startPolling();
}

// ---------------------------------------------------------------- invite popup ---

function considerInvite(inv) {
  if (!inv) {
    if (state.invite) hideInvite();
    return;
  }
  const key = `${inv.from}|${inv.at}`;
  if (state.seen.has(key)) return;
  if (state.invite && state.invite.from === inv.from && state.invite.at === inv.at) return;
  // Already in that room (accepted from another tab, or we are the host).
  if (state.room && state.room.code === inv.room) return;
  state.invite = inv;
  renderInvite();
}

/** Drop the popup element only; `state.invite` is cleared by the caller. */
function removeInviteEl() {
  const el = $('#pb-coop-invite');
  if (el) el.remove();
}

function hideInvite() {
  state.invite = null;
  removeInviteEl();
}

function renderInvite() {
  removeInviteEl();
  const inv = state.invite;
  if (!inv) return;
  const el = h('div', { class: 'season-modal', id: 'pb-coop-invite' },
    h('div', { class: 'panel season-card pb-invite' },
      h('div', { class: 'pb-inv-ic' }, sprite(myDex(), 'pix pb-inv-spr')),
      h('h2', { style: 'margin:0' },
        h('b', { class: 'pb-gold', translate: 'no' }, inv.name || 'A friend'),
        ' invites you to play in their room'),
      h('p', { class: 'muted', style: 'margin:0' },
        `Room ${inv.room}`),
      h('div', { class: 'row cl-mbtns pb-inv-btns' },
        h('button', { class: 'btn green', onclick: () => acceptInvite(inv) }, 'Accept'),
        h('button', { class: 'btn ghost', onclick: () => declineInvite(inv) }, 'Decline'))));
  document.body.append(el);
  retime();
}

async function acceptInvite(inv) {
  if (state.busy) return;
  state.busy = true;
  state.seen.add(`${inv.from}|${inv.at}`);
  try {
    const r = await api('POST', `/invites/${encodeURIComponent(inv.from)}/accept`, { dex: myDex() });
    hideInvite();
    state.room = r.room;
    await joinSession(r.room);
    openLobby();
  } catch (e) {
    hideInvite();
    toast(e.message, true);
  } finally {
    state.busy = false;
  }
}

async function declineInvite(inv) {
  state.seen.add(`${inv.from}|${inv.at}`);
  hideInvite();
  await api('POST', `/invites/${encodeURIComponent(inv.from)}/decline`).catch(() => {});
  poll();
}

// ------------------------------------------------------------------- screens ---

function uiRoot() {
  return document.getElementById('ui');
}

/** Remove our screen without touching whatever the bundle rendered. */
function unmount() {
  if (state.mounted && state.mounted.parentNode) state.mounted.remove();
  state.mounted = null;
  state.el = {};
  state.renderKey = '';
}

/** Mount `node` as the topmost layer inside #ui. */
function mount(node) {
  const root = uiRoot();
  if (!root) return;
  unmount();
  root.append(node);
  state.mounted = node;
}

/** Re-render the open screen (also re-mounts if the bundle wiped #ui). */
function render(force) {
  if (!state.screen) return;
  const root = uiRoot();
  if (!root) return;
  // Skip the DOM work when nothing the screen draws has changed. This keeps the
  // 2.5 s poll from stealing focus or wiping the add-friend input mid-typing.
  const key = state.screen + '|' + JSON.stringify(state.friends || null) + '|' +
    JSON.stringify(state.room || null) + '|' + JSON.stringify(state.msg) + '|' +
    JSON.stringify(state.suggest) + '|' + (state.starting ? 1 : 0);
  const mounted = state.mounted && state.mounted.parentNode === root &&
    state.mounted.dataset.kind === state.screen;
  if (mounted && !force && key === state.renderKey) return;

  const active = document.activeElement;
  const focusSel = active && active.closest && active.closest('#ui .screen[data-kind]')
    ? (active.id ? '#' + active.id : active.className.split(' ').map((c) => '.' + c).join(''))
    : null;
  const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

  const el = state.screen === 'friends' ? friendsScreen() : lobbyScreen();
  if (mounted) state.mounted.replaceWith(el);
  else { unmount(); root.append(el); }
  state.mounted = el;
  state.renderKey = key;

  // Restore focus + caret into the freshly built input.
  if (focusSel) {
    const again = el.querySelector(focusSel);
    if (again) {
      again.focus();
      if (selStart != null && typeof again.setSelectionRange === 'function') {
        try { again.setSelectionRange(selStart, selStart); } catch { /* not a text input */ }
      }
    }
  }
}

function head(title, sub, back) {
  return h('div', { class: 'scr-head' },
    h('button', { class: 'back-btn', onclick: back }, 'Back'),
    h('div', { class: 'scr-title' }, h('h1', {}, title), h('span', {}, sub)),
    h('div', { class: 'grow' }));
}

function toast(text, bad) {
  if (!text) return;
  const el = h('div', { class: 'app-notice' }, text);
  if (bad) el.style.background = 'var(--red-d)';
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2400);
  setTimeout(() => el.remove(), 3000);
}

// --- Friends -----------------------------------------------------------------

const STATUS_RANK = { in: 0, ok: 1, out: 2 };

function friendRows() {
  const f = state.friends || { friends: [], incoming: [], outgoing: [] };
  const room = state.room;
  const rows = [];
  for (const x of f.incoming || []) rows.push({ ...x, status: 'in' });
  for (const x of f.friends || []) rows.push({ ...x, status: 'ok' });
  for (const x of f.outgoing || []) rows.push({ ...x, status: 'out' });
  rows.sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || String(a.name).localeCompare(String(b.name)));
  return { rows, room };
}

function stateText(f, room) {
  if (f.status === 'in') return 'Wants to be your friend';
  if (f.status === 'out') return 'Friend request sent';
  if (room && room.members && room.members.some((m) => m.uid === f.id)) return 'In your room';
  if (f.play) return 'Playing';
  if (f.online) return 'Online';
  return '';
}

function friendsScreen() {
  const me = state.me;
  const { rows, room } = friendRows();
  const list = h('div', { class: 'fr-list' });

  if (!rows.length) {
    list.append(h('div', { class: 'fr-empty' },
      sprite(myDex(), 'pix pb-empty-spr'),
      h('h3', {}, 'You have no friends here yet'),
      h('p', { class: 'muted' }, 'Add other trainers by name: once they accept, you will see them here.')));
  }
  for (const f of rows) {
    const inRoom = room && room.members && room.members.some((m) => m.uid === f.id);
    const tools = h('span', { class: 'cl-mem-tools fr-tools' });
    const btn = (label, cls, fn) => h('button', { class: `btn small ${cls}`, onclick: fn }, label);
    if (f.status === 'in') {
      tools.append(
        btn('Accept', 'green', () => act(() => api('POST', `/friends/requests/${encodeURIComponent(f.id)}/accept`), `You are now friends with ${f.name}`)),
        btn('Decline', 'ghost', () => act(() => api('POST', `/friends/requests/${encodeURIComponent(f.id)}/decline`))));
    } else if (f.status === 'out') {
      tools.append(btn('Cancel', 'ghost', () => act(() => api('POST', `/friends/requests/${encodeURIComponent(f.id)}/cancel`))));
    } else {
      const canInvite = !inRoom && (!room || room.host === me.id);
      if (canInvite) {
        tools.append(btn('Invite', 'green', async () => {
          try {
            const r = await api('POST', '/invites', { to: f.id });
            state.room = r.room;
            toast(`Invitation sent to ${f.name}`);
            openLobby();
          } catch (e) { toast(e.message, true); }
        }));
      }
      tools.append(btn('Remove', 'ghost', async () => {
        if (!confirm(`Remove ${f.name} from your friends?`)) return;
        await act(() => api('POST', '/friends/remove', { id: f.id }));
      }));
    }
    list.append(h('div', { class: `fr-row${f.status === 'ok' && f.online ? ' on' : ''}` },
      h('div', { class: 'fr-who' },
        h('span', { class: 'fr-av' }, sprite(f.dex || myDex(), 'pix pb-av-spr'),
          h('i', { class: `fr-dot${f.status === 'ok' && f.online ? ' on' : ''}` })),
        h('span', { class: 'fr-tx' },
          h('b', { translate: 'no' }, f.name),
          h('small', {}, stateText(f, room)))),
      h('span'),
      tools));
  }

  const input = h('input', {
    class: 'field', placeholder: 'Trainer name', maxlength: String(NAME_MAX),
    autocomplete: 'off', spellcheck: 'false', value: state.addName || '',
  });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') addFriend(); });
  input.addEventListener('input', () => {
    state.addName = input.value;
    clearTimeout(input._t);
    input._t = setTimeout(() => suggest(input.value), 260);
  });
  const msg = h('div', { class: 'err' }, state.msg.text || '');
  if (!state.msg.bad) msg.style.color = 'var(--green-d)';
  const sugg = h('div', { class: 'cl-sugg' });
  for (const s of state.suggest || []) {
    sugg.append(h('button', {
      class: 'pill', onclick: () => { input.value = s.name; state.addName = s.name; input.focus(); sugg.replaceChildren(); },
    }, s.name));
  }

  const addPanel = h('div', { class: 'panel cl-box fr-add' },
    h('div', { class: 'cl-mhead' },
      h('div', {}, h('h2', { style: 'margin:0' }, 'Add friend'),
        h('small', { class: 'muted' }, 'Requests are received instantly')),
      h('div', { class: 'grow' })),
    h('div', { class: 'fr-add-row' },
      input,
      h('button', { class: 'btn green', onclick: addFriend }, 'Send request')),
    sugg, msg);

  const roomBtn = room
    ? h('button', { class: 'btn small ghost', onclick: openLobby }, 'Go to room')
    : h('button', { class: 'btn small green', onclick: createRoom }, 'Create room');

  const el = h('div', { class: 'screen dim blur sec fr', 'data-kind': 'friends' },
    head('Friends', 'Your friends, pending requests, and who is playing', close),
    h('div', { class: 'fr-wrap' },
      h('div', { class: 'col', style: 'display:flex;flex-direction:column;gap:12px;min-height:0' },
        h('div', { class: 'panel cl-box' },
          h('div', { class: 'cl-mhead' },
            h('div', { class: 'grow' },
              h('div', { class: 'pb-me' },
                'Your nickname:', ' ',
                h('b', { class: 'pb-gold', translate: 'no' }, me ? me.name : ''),
                ' · ', 'share it with friends so they can add you.')),
            roomBtn)),
        h('div', { class: 'panel cl-box' },
          h('div', { class: 'grp-head' }, h('b', {}, 'Your list'), h('small', {}, String(((state.friends && state.friends.friends) || []).length))),
          list)),
      addPanel));
  el.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.stopPropagation()));
  return el;
}

async function suggest(q) {
  q = String(q || '').trim();
  state.suggest = [];
  if (q.length < 2) { render(); return; }
  try {
    const r = await api('GET', `/players/search?q=${encodeURIComponent(q)}`);
    state.suggest = (r.players || []).slice(0, 6);
  } catch { state.suggest = []; }
  if (state.screen === 'friends') render();
}

async function addFriend() {
  const name = String(state.addName || '').trim();
  if (!name) return;
  state.msg = { text: '', bad: false };
  try {
    const r = await api('POST', '/friends', { name });
    state.msg = { text: `Request sent to ${(r.to && r.to.name) || name}.`, bad: false };
    state.addName = '';
    state.suggest = [];
  } catch (e) {
    state.msg = { text: e.message, bad: true };
  }
  await poll();
  if (state.screen === 'friends') render();
  const input = state.mounted && state.mounted.querySelector('.fr-add input');
  if (input) input.focus();
}

/** Run a mutation, refresh state, keep the screen in sync. */
async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, true);
  }
  await poll();
  if (state.screen) render();
}

// --- Lobby -------------------------------------------------------------------

function connText(m, room) {
  if (m.uid === room.host) return 'Host';
  if (room.host !== state.me.id) return m.uid === state.me.id ? 'You' : 'In room';
  const net = globalThis.__pbNet;
  const mode = net && typeof net.mode === 'function' ? net.mode(m.uid) : 'closed';
  if (mode === 'direct') return net.viaTurn && net.viaTurn(m.uid) ? 'Connected (server relay)' : 'Connected';
  if (mode === 'relay') return 'Connected (server relay)';
  if (mode === 'failed') return 'Failed to connect (retrying…)';
  // 'closed': the signaling room has no peer entry yet (net.mjs creates it on
  // the host's first syncMembers). Not an error: the lobby still works, and the
  // run start reaches the guest through the room poll even before WebRTC does.
  if (mode === 'closed') return 'In room';
  return 'Connecting…';
}

function lobbyScreen() {
  const room = state.room;
  if (!room) {
    // Do NOT swap to the friends screen here. The room arrives one poll later
    // (or when acceptInvite resolves); changing `state.screen` made that swap
    // permanent, leaving the player outside the room and without the Pokémon
    // picker even though they were a member.
    return h('div', { class: 'screen dim blur sec fr', 'data-kind': 'lobby' },
      head('Room', 'Loading…', () => { openFriends(); }),
      h('div', { class: 'cl-hub' },
        h('div', { class: 'panel cl-box' },
          h('p', { class: 'muted', style: 'margin:0' }, 'Loading your room…'))));
  }
  const me = state.me;
  const isHost = room.host === me.id;
  const members = room.members || [];
  const hostName = (members.find((m) => m.uid === room.host) || {}).name || '…';

  loadNames();
  const cards = h('div', { class: 'pb-lob-members' });
  for (let i = 0; i < members.length + 1; i++) {
    const m = members[i];
    const c = h('div', { class: `pb-lob-card${m ? '' : ' empty'}${m && !m.ready ? ' choosing' : ''}` });
    if (m) {
      const conn = connText(m, room);
      const mine = m.uid === me.id;
      c.append(
        m.ready ? sprite(m.dex || 1, 'pix pb-lob-spr') : h('div', { class: 'pb-lob-q' }, '?'),
        h('b', { translate: 'no' }, m.name),
        h('small', { class: 'muted' }, m.ready ? speciesName(m.dex) : 'Choosing a Pokémon…'),
        h('span', { class: `conn${conn === 'Connecting…' ? ' wait' : ''}` }, conn));
      if (mine) {
        c.append(h('button', { class: `btn small ${m.ready ? 'ghost' : 'green'}`, onclick: () => { state.picking = !state.picking; render(true); } },
          m.ready ? 'Change' : 'Choose Pokémon'));
      }
    } else {
      c.append(h('span', { class: 'muted' }, 'Open'));
    }
    cards.append(c);
  }

  // Your Pokémon for this room: the League roster, like the game's own picker.
  let picker = null;
  const meEntry = members.find((m) => m.uid === me.id);
  if (state.picking || (meEntry && !meEntry.ready)) {
    const grid = h('div', { class: 'pb-pick-grid' });
    const roster = myRoster();
    if (!roster.length) grid.append(h('p', { class: 'muted', style: 'margin:0' }, 'Loading your Pokémon…'));
    for (const id of roster) {
      grid.append(h('button', {
        class: `pb-pick${meEntry && meEntry.ready && meEntry.dex === id ? ' on' : ''}`, title: speciesName(id),
        onclick: () => pickPokemon(id),
      }, sprite(id, 'pix'), h('small', { translate: 'no' }, speciesName(id))));
    }
    picker = h('div', { class: 'panel cl-box' },
      h('div', { class: 'grp-head' }, h('b', {}, 'Choose your Pokémon'), h('small', {}, 'Each player picks their own')),
      grid);
  }

  // Host: where the run takes place (everyone plays the same world).
  let regionBox = null;
  if (isHost) {
    const c = runChoice();
    const regions = myRegions();
    const sel = h('select', { class: 'field pb-sel', onchange: (e) => { c.biome = e.target.value; render(true); } },
      ...regions.map((r) => h('option', { value: r.id, selected: r.id === c.biome }, regionName(r.id))));
    const max = (regions.find((r) => r.id === c.biome) || { max: 0 }).max;
    const tier = h('select', { class: 'field pb-sel', onchange: (e) => { c.tier = Number(e.target.value) | 0; render(true); } },
      ...Array.from({ length: max + 1 }, (_, t) => h('option', { value: String(t), selected: t === c.tier }, `Difficulty ${t + 1}`)));
    regionBox = h('div', { class: 'panel cl-box' },
      h('div', { class: 'grp-head' }, h('b', {}, 'Region'), h('small', {}, 'Host only')),
      h('div', { class: 'pb-region' }, sel, tier));
  }

  // Host-only: invite friends who are not in the room yet.
  let inviteBox = null;
  if (isHost) {
    const inRoom = new Set(members.map((m) => m.uid));
    const free = ((state.friends && state.friends.friends) || []).filter((f) => !inRoom.has(f.id));
    const rows = h('div', { class: 'fr-list' });
    if (!free.length) {
      rows.append(h('p', { class: 'sub muted', style: 'margin:0' }, 'You have not added any friends yet.'));
    }
    for (const f of free) {
      rows.append(h('div', { class: 'fr-row' },
        h('div', { class: 'fr-who' },
          h('span', { class: 'fr-av' }, sprite(f.dex || 1, 'pix pb-av-spr'),
            h('i', { class: `fr-dot${f.online ? ' on' : ''}` })),
          h('span', { class: 'fr-tx' }, h('b', { translate: 'no' }, f.name),
            h('small', {}, f.online ? 'Online' : 'Offline'))),
        h('span'),
        h('span', { class: 'cl-mem-tools fr-tools' },
          h('button', {
            class: 'btn small green',
            onclick: async () => {
              try {
                const r = await api('POST', '/invites', { to: f.id, room: room.code });
                state.room = r.room;
                toast(`Invitation sent to ${f.name}`);
                render();
              } catch (e) { toast(e.message, true); }
            },
          }, 'Invite'))));
    }
    inviteBox = h('div', { class: 'panel cl-box' },
      h('div', { class: 'grp-head' }, h('b', {}, 'Invite a friend'), h('small', {}, 'Host only')),
      rows);
  }

  const connecting = members.some((m) => m.uid !== room.host && connText(m, room) === 'Connecting…');
  const failed = members.some((m) => m.uid !== room.host && connText(m, room) === 'Failed to connect (retrying…)');
  const choosing = members.filter((m) => !m.ready);
  // A room is reused for exactly one run: once `started`, this lobby is not a
  // setup screen any more — it is a way back into that run (or a dead end the
  // host leaves). Starting again from here is what made runs "just start".
  const roomStarted = !!room.started;
  const inRun = !!(globalThis.__pb && globalThis.__pb.run);
  const finished = roomStarted && !inRun && state.finishedRunKey === runKeyOf(room, room.seed);
  const canStart = isHost && members.length >= 2 && !connecting && !failed && !choosing.length && !roomStarted;
  const note = roomStarted
    ? (inRun ? 'This room is playing a run.'
      : finished ? (isHost ? 'This room already played its run. Leave the room to set up a new game.'
        : 'This room has already played its run. Leave the room to join another game.')
        : (isHost ? 'This room is already playing a run. You can rejoin it, but it cannot be changed.'
          : 'A run is already in progress in this room. Rejoin it, or wait for the host.'))
    : members.length < 2 ? (isHost ? 'You need at least one friend in the room.' : 'Waiting for players…')
      : choosing.length ? `Waiting for ${choosing.map((m) => m.uid === me.id ? 'you' : m.name).join(', ')} to choose a Pokémon.`
        : !isHost ? 'Everyone is ready. The game starts for everyone at the same time.'
          : failed ? 'Could not connect to a friend: network restrictions prevent peer-to-peer play.'
            : connecting ? 'Connecting to your friends…'
              : 'Everyone is ready. The game starts for everyone at the same time.';

  const el = h('div', { class: 'screen dim blur sec fr', 'data-kind': 'lobby' },
    head('Room', isHost
      ? 'You are the host. Invite friends and start when ready.'
      : `You are in ${hostName}'s room. The host will start the game.`,
    () => { openFriends(); }),
    h('div', { class: 'cl-hub' },
      h('div', { class: 'panel cl-box' },
        h('div', { class: 'cl-mhead' },
          h('div', { class: 'grow' },
            h('div', { class: 'pb-code' }, 'Room code', ' ',
              h('b', { class: 'pb-gold', translate: 'no' }, room.code)),
            h('small', { class: 'muted' }, 'Anyone with the code can join from their friends list.')),
          h('button', { class: 'btn small ghost', onclick: () => copyCode(room.code) }, 'Copy code')),
        cards),
      picker,
      regionBox,
      inviteBox,
      h('div', { class: 'pb-lob-foot' },
        h('button', { class: 'btn ghost', onclick: leaveLobby }, 'Leave room'),
        roomStarted
          ? finished
            ? h('div', { class: 'pb-wait' }, 'Run finished')
            : h('button', {
              class: 'btn big green pb-start', disabled: inRun,
              onclick: () => rejoinRun(room),
            }, 'Rejoin run')
          : isHost
            ? h('button', {
              class: 'btn big green pb-start', disabled: !canStart || state.starting,
              onclick: startRun,
            }, state.starting ? 'Starting…' : `Start run (${members.length})`)
            : h('div', { class: 'pb-wait' }, 'Waiting for host…'),
        h('small', { class: 'muted pb-note' }, note))));
  return el;
}

/** Species names from the mirrored game data (loaded once, on first lobby). */
const NAMES = new Map();
let namesLoading = null;
function loadNames() {
  if (namesLoading) return namesLoading;
  namesLoading = fetch('/data/pokemon.json').then(r => r.json()).then((list) => {
    for (const p of list || []) if (p && p.id) NAMES.set(p.id, p.name);
    if (state.screen === 'lobby') render(true);
  }).catch(() => {});
  return namesLoading;
}
function speciesName(dex) {
  return NAMES.get(dex) || (dex ? `#${String(dex).padStart(3, '0')}` : '');
}

/**
 * The Pokémon this player may take into a run: its League roster. While the
 * game profile is still loading the list is empty, which left the lobby on
 * "Loading your Pokémon…" forever if nothing else re-rendered it; fall back to
 * the species this player already plays with and retry once.
 */
function myRoster() {
  const meta = globalThis.__pbApp && globalThis.__pbApp.meta;
  const league = meta && meta.profile && meta.profile.league;
  const out = Array.isArray(league)
    ? league.filter((id) => { try { return meta.inLeague(id); } catch { return false; } })
    : [];
  if (out.length) return out;
  const dex = myDex();
  if (dex) { state.rosterTries = 0; return [dex]; }
  if (state.screen === 'lobby' && !state.rosterRetry && state.rosterTries < 20) {
    state.rosterTries += 1;
    state.rosterRetry = true;
    setTimeout(() => {
      state.rosterRetry = false;
      if (state.screen === 'lobby') render(true);
    }, 800);
  }
  return out;
}

/** Regions the host has unlocked, with the highest difficulty for each. */
function myRegions() {
  const meta = globalThis.__pbApp && globalThis.__pbApp.meta;
  const b = (meta && meta.profile && meta.profile.biomes) || {};
  return Object.entries(b).filter(([, t]) => Number.isInteger(t) && t >= 0).map(([id, t]) => ({ id, max: t }));
}
const regionName = (id) => String(id || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** The host's choice of region/difficulty for the next run. */
function runChoice() {
  const regions = myRegions();
  const meta = globalThis.__pbApp && globalThis.__pbApp.meta;
  const last = meta && meta.profile && meta.profile.lastBiome;
  let c = state.runCfg;
  if (!c || !regions.some((r) => r.id === c.biome)) {
    const r = regions.find((x) => x.id === last) || regions[0] || { id: 'forest', max: 0 };
    c = state.runCfg = { biome: r.id, tier: 0, mode: 'standard' };
  }
  const r = regions.find((x) => x.id === c.biome);
  if (r && c.tier > r.max) c.tier = r.max;
  return c;
}

async function pickPokemon(dex) {
  const room = state.room;
  if (!room) return;
  const meta = globalThis.__pbApp && globalThis.__pbApp.meta;
  let shiny = false;
  try { shiny = !!(meta && meta.shinySkin(dex)); } catch { /* no skins */ }
  try {
    const r = await api('POST', `/rooms/${room.code}/pick`, { dex, shiny });
    state.room = r.room;
    state.picking = false;
    // The game's own screens default to this one too.
    if (meta && meta.profile) { meta.profile.lastSpecies = dex; try { meta.save(); } catch { /* offline */ } }
  } catch (e) { toast(e.message, true); }
  render(true);
}

/** Wait until the game app has booted (and loaded the profile). */
async function appReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const app = globalThis.__pbApp;
    if (app && app.meta && app.meta.profile && typeof app.startRun === 'function') return app;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * Start OUR run of a co-op game from the room's config. The same for the host
 * and every guest, and for a teammate coming back mid-run: nobody waits for
 * anybody's run to exist. The bridge merges the seed/biome/tier/mode into the
 * run (bundle patch A17), so every world is identical; the species is the one
 * this player picked in the lobby.
 */
async function launchRun(cfg, room) {
  const app = await appReady();
  const me = (room.members || []).find((m) => m.uid === state.me.id);
  const species = (me && me.dex) || myDex();
  await joinSession(room);
  if (globalThis.__pbSetRunCfg) globalThis.__pbSetRunCfg(cfg);
  close();
  if (app && species) {
    const ok = await app.startRun({ species, biome: cfg.biome, tier: cfg.tier | 0, mode: cfg.mode || 'standard', boosts: [] });
    if (ok && globalThis.__pb && globalThis.__pb.run) return true;
  }
  // Fallback: walk the game's own screens.
  return startLocalRun();
}

async function createRoom() {
  if (state.busy) return;
  state.busy = true;
  try {
    const r = await api('POST', '/rooms', { dex: myDex() });
    state.room = r.room;
    await joinSession(r.room);
    openLobby();
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.busy = false;
  }
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast(`Code copied: ${code}`);
  } catch {
    toast(code);
  }
}

async function leaveLobby() {
  const room = state.room;
  if (!room) { openFriends(); return; }
  try { await api('POST', `/rooms/${room.code}/leave`); } catch { /* already gone */ }
  state.room = null;
  const coop = globalThis.__pbCoop && globalThis.__pbCoop.Coop;
  if (coop && globalThis.__pbCoop && globalThis.__pbCoop.instance && globalThis.__pbCoop.instance.leave) {
    try { globalThis.__pbCoop.instance.leave(); } catch { /* not in a run */ }
  }
  openFriends();
}

/**
 * Hand the room to the co-op bridge. `__pbStartCoop` opens the signaling room
 * and waits for a run to appear (the bundle sets `globalThis.__pb.run` when a run
 * starts), so it is safe to call before the lobby closes.
 */
async function joinSession(room) {
  if (!globalThis.__pbStartCoop) return;
  const members = (room.members || []).map((m) => ({
    uid: m.uid, name: m.name, dex: m.dex | 0, shiny: !!m.shiny,
  }));
  try {
    // `__pbStartCoop` lazily loads the Firebase compat SDK from the gstatic CDN
    // and signs in anonymously. On a slow or blocked network that await can hang
    // indefinitely, which used to wedge the guest before its run ever started.
    // Bound it so the caller can reset and retry.
    await Promise.race([
      globalThis.__pbStartCoop({
        room: room.code, host: room.host, uid: state.me.id,
        members, seed: room.seed ?? null,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('co-op session timed out')), 20000)),
    ]);
    if (globalThis.__pbSetMembers) globalThis.__pbSetMembers(members);
    // The host opens the WebRTC peers for everyone in the room; this is what
    // turns 'Connecting…' into 'Connected' in the lobby cards.
    if (room.host === state.me.id && globalThis.__pbNet) {
      const net = globalThis.__pbNet;
      if (net.isOpen && net.isOpen()) net.syncMembers(members.map((m) => m.uid));
    }
  } catch (e) {
    console.warn('[coop] session', e);
  }
}

/**
 * Drive the bundle's own run-start path, exactly like a player would:
 *   menu -> `Jugar` (.mm-item.play) -> Liga -> `¡Te elijo a ti!` (.ls-go)
 *   -> region screen -> `¡Empezar!` (.rg-go button)
 * The bundle then POSTs /runs and sets globalThis.__pb.run, which is what the
 * bridge waits for before it calls coop.begin(). Returns true once a run exists.
 *
 * The region screen (`Elige región`, class `.rg`) is the last step and is NOT
 * optional: `.ls-go` only opens it. Its confirm button is
 * `<div class="rg-go"><button class="btn big red" onclick=T>` — `.rg-go button`
 * is unique in the bundle (main-D5OUVqGK, L73997), so it is the anchor used here.
 */
async function startLocalRun() {
  if (globalThis.__pb && globalThis.__pb.run) return true;
  const ui = uiRoot();
  if (!ui) return false;
  // Our lobby sits on top of the menu: get out of the way first.
  close();
  const play = ui.querySelector('.mm-item.play');
  if (play) play.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const go = ui.querySelector('.ls-go:not([disabled])');
    if (go) { go.click(); break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  // Region screen: press `¡Empezar!`. It is re-rendered by the bundle, so retry
  // until it exists and is enabled, then keep pressing until the run appears
  // (a second press is harmless — the screen unmounts once the run starts).
  const t1 = Date.now();
  let pressedAt = 0;
  while (Date.now() - t1 < 30000) {
    if (globalThis.__pb && globalThis.__pb.run) return true;
    const start = ui.querySelector('.rg-go button:not([disabled])');
    if (start && Date.now() - pressedAt > 1200) {
      start.click();
      pressedAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return !!(globalThis.__pb && globalThis.__pb.run);
}

/**
 * Host: everyone has picked a Pokémon. Publish the run config (a fresh seed +
 * the region/difficulty chosen in the lobby) to the room and to every peer, and
 * start our own run from it like everyone else — nobody goes first.
 */
async function startRun() {
  const room = state.room;
  if (!room || state.starting) return;
  if (room.host !== state.me.id || (room.members || []).length < 2) return;
  if ((room.members || []).some((m) => !m.ready)) return;
  state.starting = true;
  try {
    const choice = runChoice();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const cfg = { biome: choice.biome, tier: choice.tier | 0, mode: choice.mode || 'standard' };
    const r = await api('POST', `/rooms/${room.code}/start`, { seed, cfg });
    state.room = r.room;
    await joinSession(r.room);
    // Faster than the guests' room poll.
    const net = globalThis.__pbNet;
    if (net && net.isOpen && net.isOpen()) net.broadcast({ k: 'go', seed, cfg });
    state.starting = false;
    state.lobbyBaseline = runKeyOf(r.room, seed);
    state.pendingRun = null;
    followHost({ ...cfg, seed }, r.room);
  } catch (e) {
    toast(e.message, true);
    state.starting = false;
    render();
  }
}

/**
 * Explicit way into a room whose run is already going (the player was on another
 * screen when it started, or the room was already started when they opened it).
 */
function rejoinRun(room) {
  room = room || state.room;
  if (!room || room.seed == null) { toast('The run is no longer available.', true); return; }
  const cfg = { ...(room.cfg || {}), seed: room.seed };
  state.lobbyBaseline = runKeyOf(room, cfg.seed);
  state.pendingRun = null;
  followHost(cfg, room);
}

/**
 * Everyone (host included): the room's game has started — start our run from
 * its config. Reached from the room poll (`room.started` + `room.cfg`), from the
 * host's `go`/`start` message (bridge -> `hostStarted`) and, for the host, from
 * startRun(); `followed` keeps one run per start. Also how a player that dropped
 * gets back into a run that is still going.
 */
async function followHost(cfg, room) {
  if (!cfg || !Number.isFinite(cfg.seed) || state.starting) return;
  if (state.followed === cfg.seed) return;
  if (globalThis.__pb && globalThis.__pb.run) return;
  room = room || state.room;
  if (!room) return;
  state.starting = true;
  state.followed = cfg.seed;
  try {
    const ok = await launchRun(cfg, room);
    if (ok) {
      // Reloading mid-run must bring us back; reloading after it ended must not
      // start it again (runEnded clears this intent).
      rememberFollow(room, cfg.seed);
      return;       // `starting` is cleared when that run ends (runEnded)
    }
    state.followed = null;
    toast('Could not start the run. Retrying…', true);
  } catch (e) {
    // Never leave `starting` latched: a hung Firebase/CDN load or a failed run
    // start used to wedge the guest at "Waiting for host…" forever.
    state.followed = null;
    console.warn('[coop] guest start failed', e);
    toast('Could not join the run. Retrying…', true);
  }
  state.starting = false;
}

// ------------------------------------------------------------------ open/close ---

function dismissTour() {
  const tour = document.querySelector('.tour');
  if (tour) {
    const skip = tour.querySelector('.tour-skip');
    if (skip) skip.click(); else tour.remove();
  }
}

function openFriends() {
  if (!sessionChanged()) {
    toast('Sign in to play with friends.', true);
    return;
  }
  dismissTour();
  state.screen = 'friends';
  state.msg = { text: '', bad: false };
  startPolling();
  retime();
  render(true);
  poll();
}

function openLobby() {
  if (!sessionChanged()) return;
  state.roomAt = Date.now();
  // First look at the room decides whether a started run happened while we
  // were watching (auto-enter) or was already running (ask, do not barge in).
  state.lobbyBaseline = undefined;
  dismissTour();
  state.screen = 'lobby';
  startPolling();
  retime();
  render(true);
  poll();
}

function close() {
  state.screen = null;
  unmount();
  retime();
}

async function poll() {
  // Pick up a sign-in that happened after this module loaded (every new guest):
  // without it nothing was polled, so invites never showed up.
  sessionChanged();
  if (!state.token) return;
  const asked = Date.now();
  try {
    const f = await api('GET', '/friends');
    // An answer to a question asked before we entered the room says nothing
    // about it: it used to bounce a player who had just joined out of the lobby.
    if (!f.room && state.roomAt && asked < state.roomAt) f.room = state.room;
    state.friends = f;
    if (f.room) {
      state.room = f.room;
      state.roomMiss = 0;
    } else if (state.screen === 'lobby' && state.room) {
      // One miss does NOT mean the room closed. On a horizontally scaled API
      // (Vercel) a poll can land on an instance that has not seen the room, and
      // the old code answered that with "The room has closed" + a jump to the
      // friends screen — which also removed the Pokémon picker. Ask for the
      // room we know by code before believing it.
      let still = null;
      try {
        const r = await api('GET', `/rooms/${encodeURIComponent(state.room.code)}`);
        still = r && r.room;
      } catch (e) {
        if (e.status !== 404) return;   // a network blip is not a closed room
      }
      if (still) {
        state.room = still;
        f.room = still;
        state.roomMiss = 0;
      } else {
        state.roomMiss += 1;
        if (state.roomMiss < 2) { if (state.screen) render(); return; }
        state.room = null;
        toast('The room has closed.', true);
        openFriends();
        return;
      }
    }
    considerInvite(f.invite);

    if (f.room) {
      // Host: connect peers while the lobby is still open, not at Start.
      syncRoomMembers(f.room);
    }

    // Guests follow the host's start. Only when it happens while this tab is
    // watching the lobby, or when this tab had a live run here and reloaded:
    // a room stays `started` after its run, so blindly following it is what
    // made the game "suddenly start" on a menu.
    if (f.room && f.room.started && f.room.host !== state.me.id && f.room.seed != null) {
      const cfg = { ...(f.room.cfg || {}), seed: f.room.seed };
      const key = runKeyOf(f.room, f.room.seed);
      // First look: record where the room is, do not enter. A later change of
      // this key while the lobby is open is a start we watched happen.
      let changed = false;
      if (state.lobbyBaseline === undefined) state.lobbyBaseline = key;
      else if (state.lobbyBaseline !== key) { changed = true; state.lobbyBaseline = key; }
      const follow = intentMatches(f.room, f.room.seed) ||
        (state.screen === 'lobby' && changed && !state.starting);
      if (follow) {
        state.pendingRun = null;
        followHost(cfg, f.room);
        return;
      }
      state.pendingRun = { cfg, room: f.room };
      if (state.screen === 'lobby') render();
      return;
    }
    if (f.room && !f.room.started) {
      state.pendingRun = null;
      if (state.screen === 'lobby') state.lobbyBaseline = null;
    }
    if (state.screen) render();
  } catch (e) {
    if (e.status === 401) stopPolling();
  }
}


// --------------------------------------------------------------- CO-OP button ---
//
// The served bundle has no co-op button and no `CO-OP` string: `grep -ri "co-op"
// public/assets` only matches `.run.coop` (the netcode hooks) and the locale files
// have no such label. The Friends screen is reachable from the bundle's own
// Friends button instead: `hE()` renders `<button class="tr-mail tr-friends"
// title="Amigos">` in the trainer bar (`main-D5OUVqGK-mvilprw2.js`), and its
// onclick opens the bundle's friends screen. We bind a delegated listener on #ui
// so that button opens OUR screen, and add a "CO-OP" pill of our own to that same
// trainer bar so the entry point is visible even before the bar exists.
//
// Delegated listener (capture) because the button is created by the bundle and
// re-created on every menu render, and because its own click handler is attached
// with addEventListener (no way to unbind it) — we run first and stop it.

function bindCoopButton() {
  if (bindCoopButton.done) return;
  bindCoopButton.done = true;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest('#ui .tr-friends, #ui .pb-coop-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    sessionChanged();
    if (state.room) openLobby();
    else openFriends();
  }, true);

  // Also catch keyboard activation (Enter/Space on the focused button).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (!(t instanceof Element) || !t.matches('#ui .tr-friends, #ui .pb-coop-btn')) return;
    e.preventDefault();
    e.stopPropagation();
    sessionChanged();
    if (state.room) openLobby();
    else openFriends();
  }, true);
}

/** A gold "CO-OP" pill next to the trainer's name in the menu's trainer bar. */
function decorateMenu() {
  const bar = document.querySelector('#ui .mm .trainer');
  if (!bar || bar.querySelector('.pb-coop-btn')) return;
  const btn = h('button', { class: 'btn small green pb-coop-btn', title: 'Play with friends' },
    'CO-OP');
  const tx = bar.querySelector('.tr-tx');
  if (tx) tx.after(btn); else bar.append(btn);
}

// The menu is re-rendered by the bundle (setScreen), so watch #ui for it.
let decorateQueued = false;
const queueDecorate = () => {
  if (decorateQueued) return;
  decorateQueued = true;
  setTimeout(() => { decorateQueued = false; try { decorateMenu(); } catch { /* ignore */ } }, 120);
};
try {
  new MutationObserver(queueDecorate).observe(document.body, { childList: true, subtree: true });
} catch { /* older browser: the button still works from the Friends screen */ }

// ---------------------------------------------------------------- boot/globals ---

/**
 * Scoped styles for what the game's CSS does not already provide. Everything
 * else reuses the bundle's own classes (`.screen.dim.blur.sec`, `.scr-head`,
 * `.scr-title`, `.panel.cl-box`, `.btn`, `.fr-row`, `.fr-av`, `.fr-dot`,
 * `.fr-empty`, `.season-modal`, `.season-card`), so the screens look like the
 * rest of the menu (dark purple surfaces, gold accents, rounded cards).
 */
const CSS = `
.pb-gold{color:var(--yellow-d)}
/* Our screens are siblings of the bundle's .screen inside #ui, which has no
   z-index of its own: paint above it whatever the render order is. */
#ui>.screen[data-kind]{z-index:20;background:radial-gradient(ellipse at 50% -10%, #2a2350f2 0%, #1a1630fa 55%, #140e32fc 100%)}
body:has(#ui>.screen[data-kind]) .tour{display:none!important}
#ui>.screen[data-kind] .panel{background:#fff}
#ui>.screen[data-kind] .pb-me,#ui>.screen[data-kind] .pb-code{color:#efeaff}
.pb-me{font-size:15px;font-weight:800;line-height:1.35}
.pb-av-spr{width:40px;height:40px;background:var(--paper-2);border-radius:12px;padding:2px}
.pb-empty-spr{width:72px;height:72px;opacity:.85}
.pb-coop-btn{margin-left:6px;white-space:nowrap}

/* Lobby: member cards */
.pb-lob-members{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}
.pb-lob-card{
  position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;
  min-width:118px;padding:10px 12px 8px;border-radius:18px;
  background:linear-gradient(180deg,#241d47,#1a1630);color:#fff;
  box-shadow:0 4px 0 #120d28, var(--shadow-sm);border:2px solid #3a335c;
}
.pb-lob-card.empty{border-style:dashed;background:#1a163055;color:#8f88b5;justify-content:center;min-height:132px}
.pb-lob-card b{font-family:var(--font-title);font-size:16px;font-weight:900;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-lob-card small{color:#b9aef2;font-size:12px;font-weight:700}
.pb-lob-spr{width:64px;height:64px;filter:drop-shadow(0 3px 0 #0004)}
.pb-lob-card .conn{font-size:11px;font-weight:800;color:#9df0bd;margin-top:2px;text-align:center;line-height:1.2}
.pb-lob-card .conn.wait{color:#ffd76e}
.pb-lob-card.choosing{border-color:#ffcb3d}
.pb-lob-card .btn{margin-top:6px}
.pb-lob-q{width:64px;height:64px;display:grid;place-items:center;font:900 34px var(--font-title);color:#ffcb3d}
.pb-pick-grid{display:flex;flex-wrap:wrap;gap:8px;max-height:260px;overflow:auto}
.pb-pick{display:flex;flex-direction:column;align-items:center;width:82px;padding:6px 4px;border-radius:14px;
  border:2px solid #3a335c;background:#1a1630;color:#efeaff;cursor:pointer}
.pb-pick img{width:48px;height:48px}
.pb-pick small{font-size:11px;font-weight:800;max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-pick.on,.pb-pick:hover{border-color:#ffcb3d}
.pb-region{display:flex;gap:10px;flex-wrap:wrap}
.pb-sel{min-width:180px}

/* Lobby footer */
.pb-lob-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px}
.pb-start{flex:1 1 260px;max-width:420px}
.pb-wait{flex:1 1 240px;padding:14px 18px;border-radius:999px;background:#1a1630;color:#ffcb3d;
  font-weight:900;text-align:center;box-shadow:inset 0 0 0 2px #3a335c}
.pb-note{flex:1 1 100%;color:#b9aef2;font-weight:700}
.pb-code{font-size:16px;font-weight:800}
.pb-code b{font-family:var(--font-title);font-size:26px;letter-spacing:3px}

/* Invite popup */
.pb-invite{text-align:center;align-items:center}
.pb-inv-ic{display:grid;place-items:center;width:84px;height:84px;border-radius:50%;
  background:radial-gradient(circle,#2c2450,#1a1630);box-shadow:0 0 0 3px #ffcb3d}
.pb-inv-spr{width:64px;height:64px}
.pb-inv-btns{justify-content:center;gap:10px}
.pb-inv-btns .btn{min-width:130px}
`;
const styleEl = document.createElement('style');
styleEl.id = 'pb-coop-css';
styleEl.textContent = CSS;
document.head.append(styleEl);

globalThis.__pbCoopUI = {
  openFriends, openLobby, close,
  get room() { return state.room; },
  get friends() { return state.friends; },
  get screen() { return state.screen; },
  refresh: poll,
  // Bridge -> UI: the host's `start`/`go` message. Only launch when this tab is
  // watching the lobby (or it was in that run and reloaded); otherwise offer it.
  hostStarted(cfg) {
    if (!cfg || !Number.isFinite(cfg.seed)) return;
    const room = state.room;
    // The bridge also sees the host's `start` broadcast when its run actually
    // comes up — which can be several seconds AFTER the room was marked started.
    // If we already saw that start while not watching the lobby (pendingRun),
    // this late message is the same start, not a new one: keep offering it.
    const pendingSame = !!(state.pendingRun && state.pendingRun.cfg &&
      state.pendingRun.cfg.seed === cfg.seed);
    if (intentMatches(room, cfg.seed) ||
        (state.screen === 'lobby' && !pendingSame)) {
      state.lobbyBaseline = runKeyOf(room, cfg.seed);
      state.pendingRun = null;
      followHost(cfg, room);
      return;
    }
    const duplicate = pendingSame;
    state.pendingRun = { cfg, room };
    if (!duplicate) toast('The host started a run. Open the room to join.', false);
  },
  runEnded() {
    state.starting = false;
    forgetFollow();
    // Do not let the still-`started` room launch the finished run again.
    if (state.room && state.room.started) {
      state.lobbyBaseline = runKeyOf(state.room, state.room.seed);
      state.finishedRunKey = runKeyOf(state.room, state.room.seed);
    }
  },
};

sessionChanged();
bindCoopButton();
startPolling();
queueDecorate();
