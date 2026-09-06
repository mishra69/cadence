// skill-asset: version-check.js v1.0.0 (canonical: skills/pwa-cloudflare/assets/version-check.js)
/*
 * Build stamp + stale-build detection. Merge into the app's boot code.
 *
 * Requires:
 *   - CONFIG.VERSION (or any global) stamped by deploy.sh
 *   - elements marked [data-version] wherever you want the build shown
 *   - sw.js passing ?_v= requests straight to the network
 */

const VersionUI = {
  init() {
    this.render();
    this.checkStale();
    // A new service worker taking over means a new build just landed.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', () => this.checkStale());
    }
  },

  render(text) {
    const label = text || (CONFIG.VERSION === 'dev' ? 'dev build' : 'v' + CONFIG.VERSION);
    document.querySelectorAll('[data-version]').forEach(el => { el.textContent = label; });
  },

  // The app boots from the service worker cache, so a freshly deployed build
  // can sit behind a stale cache until the new worker activates. Compare what
  // the server has against what's actually running.
  async checkStale() {
    if (CONFIG.VERSION === 'dev' || !navigator.onLine) return;
    try {
      // ?_v= is what makes this bypass the service worker. Without it the probe
      // is served from the same cache the app booted from, so a stale build
      // always looks current and this check can never fire.
      const res = await fetch('/js/config.js?_v=' + Date.now(), { cache: 'no-store' });
      const live = (await res.text()).match(/VERSION: '([^']*)'/);
      if (!live || live[1] === CONFIG.VERSION) return;
      this.render(`v${CONFIG.VERSION} — v${live[1]} available, reopen to update`);
    } catch (e) {
      /* offline or blocked: the version already shown is still accurate */
    }
  },
};
