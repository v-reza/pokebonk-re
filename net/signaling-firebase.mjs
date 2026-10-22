// net/signaling-firebase.mjs — client-side Firebase SDK adapter for co-op signaling.
//
// Gives net.mjs a working Realtime Database handle so WebRTC signaling and the
// relay path can run against Firebase Realtime Database. Loads the Firebase JS SDK
// **compat** API from the gstatic CDN (no npm/bundler — this file runs in the
// browser), exactly like pokesurvivor's js/core/db.js, so the `firebase` global
// exposes `initializeApp`, `database()`, `auth()` and `database.ServerValue`.
//
// The db handle shape this must satisfy is what net.mjs's init(db, uid) consumes:
//
//   db.rtdb.ref('rooms/' + id + '/q/' + uid)      -> Reference
//   ref.on('child_added', snap)                   -> snap.val(), snap.ref.remove()
//   ref.off() · ref.set(v) · ref.push(v) · ref.remove() · ref.update(obj)
//   firebase.database.ServerValue.TIMESTAMP       -> {'.sv': 'timestamp'}
//
// Rooms schema (matches firebase/database.rules.json):
//   rooms/{id}/{ host, open, at, m/{uid}, q/{to}/{msg} }
//   - `host` written once by the host at creation
//   - `open`/`at` host-only
//   - `m/{uid}` each member writes their own presence entry
//   - `q/{to}/{msg}` any member pushes a signal/message to the recipient `to`
//
// IMPORTANT: this file is client-only. It cannot be imported under Node — it uses
// `document`/`globalThis.firebase`. The Firebase SDK is NOT an npm dependency; it
// is fetched from the CDN at runtime in the browser.

// One pinned SDK version so app/database/auth stay compatible with each other.
const SDK_VERSION = '10.14.1';
const COMPAT_SCRIPTS = [
  `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app-compat.js`,
  `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-database-compat.js`,
  `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth-compat.js`,
];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`[signaling-firebase] failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Load the three compat scripts (idempotent) and return the `firebase` global.
async function ensureFirebase() {
  if (globalThis.firebase) return globalThis.firebase;
  await Promise.all(COMPAT_SCRIPTS.map(loadScript));
  if (!globalThis.firebase) throw new Error('[signaling-firebase] firebase global missing after CDN load');
  return globalThis.firebase;
}

/**
 * Initialize Firebase and return the db handle net.mjs consumes.
 *
 * @param {object} cfg  Firebase web-app config from the Firebase console:
 *   Project settings → General → Your apps → Web app → "SDK setup and configuration".
 *   The keys net.mjs needs for RTDB are:
 *     - apiKey        Web API key (auth/identity)
 *     - authDomain    <project-id>.firebaseapp.com
 *     - projectId     Firebase project id
 *     - databaseURL   https://<project-id>-default-rtdb.firebaseio.com
 *   (storageBucket / messagingSenderId / appId are accepted but unused here.)
 * @param {string} [uid]  The authenticated user id to bind net.mjs to. If omitted,
 *   falls back to firebase.auth().currentUser?.uid. You must sign in first —
 *   typically firebase.auth().signInAnonymously() — so the security rules
 *   (which key every write off auth.uid) allow the room operations.
 * @returns {Promise<{rtdb, uid, auth, ServerValue, firebase}>}
 */
export async function init(cfg, uid) {
  const firebase = await ensureFirebase();
  if (!firebase.apps || firebase.apps.length === 0) {
    firebase.initializeApp(cfg);
  }
  const rtdb = firebase.database();
  const auth = firebase.auth();
  const resolvedUid = uid ?? (auth.currentUser ? auth.currentUser.uid : null);
  return { rtdb, uid: resolvedUid, auth, ServerValue: firebase.database.ServerValue, firebase };
}

/**
 * Convenience: sign in anonymously (if not already signed in) and return the same
 * handle, with uid taken from the resulting Firebase Auth user. This is the usual
 * wiring: a guest co-op player has no email/password, so we mint an anonymous uid.
 */
export async function initAnonymous(cfg) {
  const firebase = await ensureFirebase();
  if (!firebase.apps || firebase.apps.length === 0) {
    firebase.initializeApp(cfg);
  }
  const auth = firebase.auth();
  let user = auth.currentUser;
  if (!user) user = (await auth.signInAnonymously()).user;
  return init(cfg, user.uid);
}
