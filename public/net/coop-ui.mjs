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
  const changed = (s && s.id) !== (state.me && state.me.id);
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

const myDex = () => {
  try {
    const p = JSON.parse(localStorage.getItem('pb.save') || 'null');
    return (p && (p.partner || p.lastSpecies)) || 0;
  } catch { return 0; }
};

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
          h('div', { class: 'grp-head' }, h('b', {}, 'Your list'), h('small', {}, String((state.friends && state.friends.friends) || []))),
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
  if (!room) { state.screen = 'friends'; return friendsScreen(); }
  const me = state.me;
  const isHost = room.host === me.id;
  const members = room.members || [];
  const hostName = (members.find((m) => m.uid === room.host) || {}).name || '…';

  const cards = h('div', { class: 'pb-lob-members' });
  for (let i = 0; i < members.length + 1; i++) {
    const m = members[i];
    const c = h('div', { class: `pb-lob-card${m ? '' : ' empty'}` });
    if (m) {
      const conn = connText(m, room);
      c.append(
        sprite(m.dex || 1, 'pix pb-lob-spr'),
        h('b', { translate: 'no' }, m.name),
        h('small', { class: 'muted' }, speciesName(m.dex)),
        h('span', { class: `conn${conn === 'Connecting…' ? ' wait' : ''}` }, conn));
    } else {
      c.append(h('span', { class: 'muted' }, 'Open'));
    }
    cards.append(c);
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
  const canStart = isHost && members.length >= 2 && !connecting && !failed;
  const note = !isHost ? 'When the host starts, everyone enters together.'
    : members.length < 2 ? 'You need at least one friend in the room.'
      : failed ? 'Could not connect to a friend: network restrictions prevent peer-to-peer play.'
        : connecting ? 'Connecting to your friends…'
          : 'The game starts for everyone at the same time.';

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
      inviteBox,
      h('div', { class: 'pb-lob-foot' },
        h('button', { class: 'btn ghost', onclick: leaveLobby }, 'Leave room'),
        isHost
          ? h('button', {
            class: 'btn big green pb-start', disabled: !canStart || state.starting,
            onclick: startRun,
          }, state.starting ? 'Starting…' : `Start run (${members.length})`)
          : h('div', { class: 'pb-wait' }, 'Waiting for host…'),
        h('small', { class: 'muted pb-note' }, note))));
  return el;
}

function speciesName(dex) {
  const names = { 1: 'Bulbasaur', 4: 'Charmander', 7: 'Squirtle', 25: 'Pikachu', 133: 'Eevee' };
  return names[dex] || (dex ? `#${String(dex).padStart(3, '0')}` : '');
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
    await globalThis.__pbStartCoop({
      room: room.code, host: room.host, uid: state.me.id,
      members, seed: room.seed ?? null,
    });
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
 * Host: close the room, broadcast the start config through the bridge, then let
 * the bundle's normal run-start path proceed (`__pbStartCoop` + a run appearing).
 * The lobby closes as soon as a run exists.
 */
async function startRun() {
  const room = state.room;
  if (!room || state.starting) return;
  if (room.host !== state.me.id || (room.members || []).length < 2) return;
  state.starting = true;
  try {
    const seed = Math.floor(Math.random() * 1e9);
    const r = await api('POST', `/rooms/${room.code}/start`, { seed });
    state.room = r.room;
    const members = (r.room.members || []).map((m) => ({
      uid: m.uid, name: m.name, dex: m.dex | 0, shiny: !!m.shiny,
    }));
    // Guests pick the seed up from their poll (room.seed) and from the net layer
    // (`__pbStartCoop` + the host's `start` broadcast); the host begins locally.
    await joinSession(r.room);
    if (globalThis.__pbSetMembers) globalThis.__pbSetMembers(members);
    // Let the guests' poll see the started room + seed before we navigate away.
    await new Promise((res) => setTimeout(res, 600));
    // Now walk the bundle's normal run-start path; the bridge begins co-op as
    // soon as the run object exists. The lobby is already closed at this point.
    const ok = await startLocalRun();
    state.starting = false;
    if (!ok) toast('Could not start run.', true);
  } catch (e) {
    toast(e.message, true);
    state.starting = false;
    render();
  }
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
  if (!state.token) return;
  try {
    const f = await api('GET', '/friends');
    state.friends = f;
    if (f.room) state.room = f.room;
    considerInvite(f.invite);
    // A guest lands in the lobby as soon as the host's invite is accepted in
    // another tab, and leaves it when the host closes the room.
    if (state.screen === 'lobby' && !f.room) {
      state.room = null;
      toast('The room has closed.', true);
      openFriends();
      return;
    }
    // Guests follow the host's start: once the room is started, open the
    // signaling session (with the host's seed) and start their own run.
    if (f.room && f.room.started && f.room.host !== state.me.id && !state.starting) {
      state.starting = true;
      await joinSession(f.room);
      const ok = await startLocalRun();
      state.starting = false;
      if (!ok) toast('Could not start run.', true);
      return;
    }
    if (state.screen) render();
  } catch (e) {
    if (e.status === 401) stopPolling();
  }
}

/** Guest: close the lobby once the run the host started shows up. */
function waitForRun() {
  const t0 = Date.now();
  const wait = () => {
    if (globalThis.__pb && globalThis.__pb.run) { state.starting = false; close(); return; }
    if (Date.now() - t0 > 60000) { state.starting = false; render(); return; }
    setTimeout(wait, 120);
  };
  wait();
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
};

sessionChanged();
bindCoopButton();
startPolling();
queueDecorate();
