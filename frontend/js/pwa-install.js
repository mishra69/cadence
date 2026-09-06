// skill-asset: pwa-install.js v1.1.0 (canonical: skills/pwa-cloudflare/assets/pwa-install.js)
/*!
 * pwa-install.js — a drop-in "Add to Home Screen" prompt for any PWA.
 *
 * Zero dependencies, no build step. Renders into a shadow root so the host
 * app's CSS can't leak in and break it (and vice versa). Theme it from the
 * outside with CSS custom properties — those do cross the shadow boundary:
 *
 *   :root {
 *     --pwa-accent: #3b82f6;
 *     --pwa-surface: #ffffff;
 *     --pwa-text: #111827;
 *   }
 *
 * Usage (classic script):
 *   <script src="/js/pwa-install.js"></script>
 *   <script>
 *     PWAInstall.init({
 *       appName: 'Sudoku',
 *       sub: 'Install for offline play and a faster launch',
 *     });
 *   </script>
 *
 * Always pass `sub`, worded for this app — say what installing gains here.
 * The default is generic and belongs to no app in particular.
 *
 * The core problem it solves: Chromium fires `beforeinstallprompt` and gives
 * you a real install API; WebKit never has and shows no prompt of its own, so
 * iOS users have to be walked through the Share sheet by hand. This normalises
 * the two into one call.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PWAInstall = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let deferredPrompt = null;   // the stashed beforeinstallprompt event
  let cfg = null;
  let host = null;             // shadow host element
  let lastFocused = null;

  // Capture as early as possible — Chromium can fire this before init() runs.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();        // suppress Chromium's own mini-infobar
    deferredPrompt = e;        // .prompt() is only callable from a user gesture
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    close();
    if (cfg && cfg.onInstalled) cfg.onInstalled();
  });

  // ── Detection ────────────────────────────────────────────────────────────

  function isInstalled() {
    return navigator.standalone === true                        // iOS, non-standard
      || window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches
      || document.referrer.startsWith('android-app://');        // Android TWA
  }

  /** 'ios-safari' | 'ios-other' | 'chromium' | 'unsupported' */
  function platform() {
    const ua = navigator.userAgent;
    // iPadOS 13+ reports a Macintosh UA by default, so the classic
    // /iPad|iPhone|iPod/ test silently misses every modern iPad. Touch points
    // separate a real Mac (0) from an iPad pretending to be one (5).
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

    if (isIOS) {
      // Every iOS browser is WebKit underneath, but only some expose an
      // "Add to Home Screen" item, and it sits in different menus.
      return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
    }
    return deferredPrompt ? 'chromium' : 'unsupported';
  }

  // ── Dismissal memory ─────────────────────────────────────────────────────

  const KEY = 'pwa-install-dismissed';

  function isDismissed() {
    try {
      if (cfg.remember === 'session') return sessionStorage.getItem(KEY) === '1';
      const until = parseInt(localStorage.getItem(KEY) || '0', 10);
      return Date.now() < until;
    } catch (e) {
      return false; // private mode / storage disabled — just show it
    }
  }

  function rememberDismissal() {
    try {
      if (cfg.remember === 'session') sessionStorage.setItem(KEY, '1');
      else localStorage.setItem(KEY, String(Date.now() + cfg.remember * 864e5));
    } catch (e) { /* nothing we can do, and nothing worth breaking over */ }
  }

  // ── Content per platform ─────────────────────────────────────────────────

  function content(p) {
    const name = cfg.appName;
    if (p === 'chromium') {
      return {
        sub: cfg.sub,
        body: `<button class="cta" id="cta">Add to Home Screen</button>`,
      };
    }
    const share = p === 'ios-safari'
      ? ['Tap the <b>Share</b> button', 'The box with an arrow, in the toolbar']
      : ['Open your browser\'s <b>Share</b> menu', 'Some browsers place this under ⋯'];
    return {
      sub: cfg.sub,
      body: `<ol class="steps">
        <li><span class="n">1</span><div>${share[0]}<em>${share[1]}</em></div></li>
        <li><span class="n">2</span><div>Tap <b>Add to Home Screen</b><em>Scroll down to find it</em></div></li>
        <li><span class="n">3</span><div>Tap <b>Add</b><em>${esc(name)} appears on your home screen</em></div></li>
      </ol>`,
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; align-items: flex-end; justify-content: center;
      font-family: var(--pwa-font, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }
    .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); animation: fade .2s ease; }
    .card {
      position: relative; width: 100%; max-width: 420px; margin: 12px;
      margin-bottom: calc(12px + env(safe-area-inset-bottom));
      background: var(--pwa-surface, #fff); color: var(--pwa-text, #111827);
      border-radius: var(--pwa-radius, 16px); padding: 20px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.28);
      animation: rise .26s cubic-bezier(.2,.8,.3,1);
    }
    @media (min-width: 640px) { .wrap { align-items: center; } }
    @keyframes fade { from { opacity: 0 } }
    @keyframes rise { from { transform: translateY(16px); opacity: 0 } }
    @media (prefers-reduced-motion: reduce) { .card, .backdrop { animation: none } }
    .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .icon { width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0; }
    .title { font-size: 17px; font-weight: 700; }
    .sub { font-size: 13px; opacity: .65; margin-top: 2px; }
    .x {
      margin-left: auto; border: 0; background: transparent; cursor: pointer;
      font-size: 22px; line-height: 1; padding: 4px 8px; border-radius: 8px;
      color: inherit; opacity: .5;
    }
    .x:hover { opacity: 1; background: rgba(127,127,127,.15); }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
    .steps li { display: flex; gap: 12px; align-items: flex-start; font-size: 14px; }
    .n {
      flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
      background: var(--pwa-accent, #3b82f6); color: #fff;
      font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }
    .steps em { display: block; font-style: normal; font-size: 12px; opacity: .6; margin-top: 2px; }
    .cta {
      width: 100%; border: 0; border-radius: 10px; padding: 13px;
      background: var(--pwa-accent, #3b82f6); color: #fff;
      font-size: 15px; font-weight: 700; cursor: pointer;
      font-family: inherit; min-height: 44px; touch-action: manipulation;
    }
    .cta:active { transform: scale(.98); }

    /* Fallback only. An app with its own theme switch should map its variables
       on :root instead — custom properties inherit through the shadow boundary,
       so the sheet follows the app's theme without needing to know about it. */
    @media (prefers-color-scheme: dark) {
      .card { background: var(--pwa-surface, #1f2937); color: var(--pwa-text, #f3f4f6); }
    }
  `;

  function render(p) {
    const c = content(p);
    host = document.createElement('div');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap" role="dialog" aria-modal="true" aria-label="Install ${esc(cfg.appName)}">
        <div class="backdrop" id="bd"></div>
        <div class="card">
          <div class="head">
            ${cfg.icon ? `<img class="icon" src="${esc(cfg.icon)}" alt="">` : ''}
            <div>
              <div class="title">Add ${esc(cfg.appName)} to your Home Screen</div>
              <div class="sub">${c.sub}</div>
            </div>
            <button class="x" id="x" aria-label="Dismiss">&times;</button>
          </div>
          ${c.body}
        </div>
      </div>`;
    document.body.appendChild(host);

    sr.getElementById('x').addEventListener('click', dismiss);
    sr.getElementById('bd').addEventListener('click', dismiss);
    const cta = sr.getElementById('cta');
    if (cta) cta.addEventListener('click', trigger);

    // Focus management: move focus in, restore it on close, trap Tab inside.
    lastFocused = document.activeElement;
    (cta || sr.getElementById('x')).focus();
    host.addEventListener('keydown', e => {
      if (e.key === 'Escape') return dismiss();
      if (e.key !== 'Tab') return;
      const f = [...sr.querySelectorAll('button')];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const active = sr.activeElement;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    });
  }

  function close() {
    if (!host) return;
    host.remove();
    host = null;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function dismiss() {
    rememberDismissal();
    close();
    if (cfg && cfg.onDismiss) cfg.onDismiss();
  }

  async function trigger() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;   // the event is single-use
    if (outcome === 'accepted') close(); else dismiss();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  function canInstall() {
    return !isInstalled() && platform() !== 'unsupported';
  }

  function show(force) {
    if (host) return false;
    if (!force && (isInstalled() || isDismissed())) return false;
    const p = platform();
    if (p === 'unsupported') return false;   // nothing useful to tell the user
    render(p);
    return true;
  }

  function init(options) {
    cfg = Object.assign({
      appName: document.title || 'this app',
      // Override this. It is the only app-specific copy in the prompt.
      sub: 'Install for offline access and a faster launch',
      icon: (document.querySelector('link[rel="apple-touch-icon"]')
          || document.querySelector('link[rel="icon"]') || {}).href || null,
      autoShow: true,
      delay: 2000,        // let the app paint before interrupting
      remember: 'session', // 'session', or a number of days
      onInstalled: null,
      onDismiss: null,
    }, options || {});

    if (!cfg.autoShow) return;
    // Chromium may not have fired beforeinstallprompt yet on a cold load, so
    // the delay doubles as a window for it to arrive.
    const start = () => setTimeout(() => show(false), cfg.delay);
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  }

  return { init, show, dismiss, close, canInstall, isInstalled, platform };
});
