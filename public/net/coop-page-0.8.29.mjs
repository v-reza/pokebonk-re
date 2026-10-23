// public/net/coop-page-0.8.29.mjs — Page bootstrap for 0.8.29 co-op bridge.
import { installBridge } from './coop-bridge-0.8.29.mjs';
import { bootCoop } from './coop-boot-0.8.29.mjs';

let booted = false;
let waitingLogged = false;

function tryBoot() {
  if (booted) return;
  try {
    const run = globalThis.__pb?.run;
    const coop = run?.coop;
    const store = run?.pickups;

    if (run && coop && store) {
      bootCoop({ coop, run, store });
      booted = true;
      console.info('[pbcoop] co-op booted for run');
      return;
    }

    if (!waitingLogged) {
      waitingLogged = true;
      console.info('[pbcoop] waiting for run/session');
    }
  } catch (err) {
    console.warn('[pbcoop] boot attempt failed:', err);
  }
}

export function install() {
  const urlParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const pbcoopParam = urlParams?.has('pbcoop') && urlParams.get('pbcoop') === '1';

  if (globalThis.__PB_COOP_AUTOLOAD__ === false && !pbcoopParam) {
    return;
  }

  installBridge();

  tryBoot();

  if (!booted && typeof window !== 'undefined') {
    const onStart = () => tryBoot();
    window.addEventListener('pokebonk:run-start', onStart, { once: true });
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      tryBoot();
      if (booted || attempts > 60) clearInterval(timer);
    }, 1000);
  }
}

install();
