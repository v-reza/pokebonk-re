// Firebase web-app config for the PokéBonk local reconstruction.
// Project: pokebonk-mrezalf0 ("Pokebonk local") — Spark (free) tier.
//
// This is a CLIENT-side config (apiKey is a public browser key, not a secret).
// It is safe to ship in the client bundle. The admin/service-account credentials
// used by server.mjs --firebase are separate and must NEVER be committed.
//
// Used by net/signaling-firebase.mjs (co-op signaling + rooms) in the browser.
export const firebaseConfig = {
  apiKey: 'AIzaSyAE9JRHtTnYBCIPrlqgJnACPrP4Uq3vJ70',
  authDomain: 'pokebonk-mrezalf0.firebaseapp.com',
  projectId: 'pokebonk-mrezalf0',
  databaseURL: 'https://pokebonk-mrezalf0-default-rtdb.asia-southeast1.firebasedatabase.app',
  storageBucket: 'pokebonk-mrezalf0.firebasestorage.app',
  messagingSenderId: '1053673578501',
  appId: '1:1053673578501:web:1a0090ab1a64abaabc3c6c',
};
