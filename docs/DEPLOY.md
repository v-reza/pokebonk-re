# PokéBonk Deployment Guide (Vercel Serverless + Firebase)

This guide documents the full serverless production deployment of PokéBonk.

The entire stack deploys to **Vercel** with zero external Node servers to babysit:
- **Vercel Static Hosting**: Serves the game bundle, assets, and co-op client.
- **Vercel Serverless Function (`api/[...path].mjs`)**: Hosts the REST API routes (`/api/*`), backed by `firebase-admin`.
- **Firebase Authentication**: Anonymous auth for co-op guests and WebRTC signaling; Email+Password for registered trainers.
- **Firebase Cloud Firestore**: Stores trainer profiles, saves, run histories, and friendship graphs.
- **Firebase Realtime Database (RTDB)**: Stores active run states, co-op rooms, and peer-to-peer WebRTC signaling/relay messages.

```
┌────────────────────────────────────────────────────────┐
│                        Vercel                          │
│                                                        │
│  ┌─────────────────────────┐  ┌─────────────────────┐  │
│  │ Static Client (dist/)   │  │ Serverless Function │  │
│  │ HTML, WebGL, Assets,    │  │ api/[...path].mjs   │  │
│  │ Net modules, Coop UI    │  │ (~50 REST routes)   │  │
│  └───────────┬─────────────┘  └──────────┬──────────┘  │
└──────────────┼───────────────────────────┼─────────────┘
               │                           │ firebase-admin
               │ WebRTC P2P Direct         │ (Firestore + RTDB + Auth)
               │ + RTDB Signaling / Relay  ▼
               │                ┌─────────────────────────┐
               └───────────────►│      Firebase Cloud     │
                                └─────────────────────────┘
```

---

## 1. Firebase Project Setup

### A. Create Project
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a project (e.g. `pokebonk-mrezalf0`).
2. The free **Spark** tier is sufficient.

### B. Enable Authentication
1. Go to **Build > Authentication > Sign-in method**.
2. Enable **Anonymous** auth (used for guest accounts and browser RTDB signaling).
3. Enable **Email/Password** auth (used for registered trainer accounts).

### C. Create Cloud Firestore
1. Go to **Build > Firestore Database** and click **Create database**.
2. Select your nearest region (e.g. `asia-southeast1` or `us-central1`).
3. Start in **Production mode**.

### D. Create Realtime Database
1. Go to **Build > Realtime Database** and click **Create Database**.
2. Select the database region (e.g. `asia-southeast1`).
3. Note your database URL (e.g. `https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app`).

### E. Generate Admin Service Account
1. In Firebase Console, open **Project Settings (gear icon) > Service accounts**.
2. Click **Generate new private key** and download the JSON credentials file.
3. Keep this secret — do not commit it to git.

### F. Client Configuration (`firebase/firebase-config.js`)
The public web configuration in `firebase/firebase-config.js` is bundled into the client build:
```javascript
export const firebaseConfig = {
  apiKey: 'AIzaSy...',
  authDomain: '<project-id>.firebaseapp.com',
  projectId: '<project-id>',
  databaseURL: 'https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app',
  storageBucket: '<project-id>.firebasestorage.app',
  messagingSenderId: '...',
  appId: '1:...',
};
```

---

## 2. Deploy Firebase Security Rules

Deploy the security rules from the repository root using the Firebase CLI:

```bash
# Login to Firebase CLI
npx firebase-tools login

# Deploy Firestore and Database rules
npx firebase-tools deploy --only firestore:rules,database
```

The repository includes:
- `firebase/firestore.rules`: Secures `saves/`, `pres/`, `social_edges/`, `social_rooms/`, `social_invites/`, `lbs/`.
- `firebase/database.rules.json`: Enforces authenticated room creation, member presence (`rooms/{id}/m/{uid}`), and message queues (`rooms/{id}/q/{to}`).

---

## 3. Deploy to Vercel

### A. Environment Variables in Vercel
In the Vercel Project Settings under **Settings > Environment Variables**, add:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `FIREBASE_PROJECT_ID` | Your Firebase project id | `pokebonk-mrezalf0` |
| `FIREBASE_DATABASE_URL` | Your Realtime Database URL | `https://pokebonk-mrezalf0-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_SERVICE_ACCOUNT` | The full minified JSON string of the downloaded service account key | `{"type":"service_account","project_id":...}` |

### B. Vercel Configuration (`vercel.json`)
The repo includes `vercel.json` preconfigured for Vercel:
```json
{
  "buildCommand": "node tools/prepatch.mjs dist",
  "outputDirectory": "dist",
  "framework": null,
  "functions": {
    "api/[...path].mjs": {
      "includeFiles": "firebase/**"
    }
  },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "no-cache"
        }
      ]
    }
  ]
}
```

- **Build Command**: `node tools/prepatch.mjs dist` builds a standalone static client in `dist/` with co-op hooks and client networking modules.
- **Output Directory**: `dist` is served statically.
- **Functions**: Vercel automatically routes `/api/**` to `api/[...path].mjs`, tracing `firebase/**` for backend route logic.

### C. Deploy
Deploy using the Vercel CLI or by connecting your git repository in the Vercel dashboard:
```bash
npx vercel --prod
```

---

## 4. Co-op Across Two Machines: P2P & NAT Fallback

### How Co-op Works
1. When two players join a room, WebRTC data channels are negotiated directly between the host and each guest.
2. Initial SDP offers/answers and ICE candidates are exchanged through Firebase Realtime Database at `rooms/{roomId}/q/{to}`.
3. Once the WebRTC channel opens, player movement and animations flow peer-to-peer at full frame rate with zero database write load.

### TURN Status & Symmetric NAT Limitation
- **TURN is disabled** (`TURN_ON = false` in `net/net.mjs`).
- **Known Failure Mode**: When both players are behind symmetric NATs (e.g. strict mobile carrier CGNAT, university networks, or enterprise firewalls), direct peer-to-peer WebRTC cannot connect via STUN alone.
- **Relay Mitigation (`ALLOW_RELAY = true`)**: If direct connection fails within 9 seconds (`DIRECT_TIMEOUT`), `net.mjs` automatically falls back to database queue relay (`rooms/{roomId}/q/{to}`).
- **Resource Considerations**:
  - The relay ensures games never fail to connect even behind restrictive NATs.
  - However, relaying gameplay frames routes position updates through RTDB, which increases Realtime Database writes against the free Spark tier (100 simultaneous connections, 10 GB/month egress).

---

## 5. Post-Deployment Verification (End-to-End Co-op Test)

After deploying to Vercel, verify full multiplayer connectivity across two separate devices or browser sessions:

1. **Open Two Browsers**:
   - Open Browser A (Host): Navigate to your Vercel URL (e.g. `https://your-pokebonk.vercel.app/`).
   - Open Browser B (Guest): Navigate to the same URL in an incognito window or on a second device.
2. **Account Creation**:
   - In both browsers, let the game boot into the main menu.
   - Browser A: Open Social/Friends, register or note the Trainer name (e.g. `TrainerA`).
   - Browser B: Open Social/Friends, register or note the Trainer name (e.g. `TrainerB`).
3. **Friend Request**:
   - In Browser B, enter `TrainerA` in the "Add Friend" box and send a request.
   - In Browser A, accept the incoming friend request.
4. **Create & Invite**:
   - In Browser A, click "Create Room" to open the Lobby with a room code.
   - Click "Invite" next to `TrainerB`.
   - In Browser B, accept the invite modal ("TrainerA te invita a jugar"). Both players will appear in the Lobby cards.
5. **Start Game**:
   - In Browser A (Host), click **Start**.
   - **Verification Success**: Both browsers transition into the arena and render two active Pokémon sprites (host and teammate puppet) moving and syncing in real time.

---

## 6. Pending Source-Tree Change: Localhost-Only Co-op Guard in `public/index.html`

> **Note for the owner of `public/index.html`:**
> In production static builds, `tools/prepatch.mjs` automatically rewrites and secures `dist/index.html` so that the local SSE relay fallback (`?local=1`) cannot be triggered on public domains.
>
> Once your current edits in `public/index.html` settle, please adopt this guard directly into `public/index.html` around line 302:

```diff
       // `?local=1` (or setting window.__pbUseLocal = true) selects the in-memory
       // SSE relay (net/signaling-local.mjs) instead of Firebase. Defaults to Firebase.
       if (globalThis.__pbUseLocal !== true) {
         const qs = new URL(location.href).searchParams;
-        globalThis.__pbUseLocal = qs.has('local') || qs.get('coop') === 'local';
+        const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
+        globalThis.__pbUseLocal = isLocalHost && (qs.has('local') || qs.get('coop') === 'local');
       }
```
