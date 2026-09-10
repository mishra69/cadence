// Screen lock and screen hygiene (plan §4.1).
//
// This is a gate, not security. The WebAuthn assertion is never verified
// server-side and no data is gated on it — a determined attacker with the
// device and the session token in localStorage can read everything. That is a
// conscious choice: the threat model is someone standing next to me reading the
// screen, not an adversary. Nothing in the UI describes it as more than that.
//
// The two halves are deliberately separate:
//   - the VEIL blanks the view on every background, because iOS snapshots the
//     app for the app switcher and that thumbnail bypasses the lock entirely.
//   - the LOCK re-arms only after an idle timeout, so a two-second app switch
//     mid-log isn't punished.

const Lock = (() => {
  const K_CRED = 'cadence.cred_id';
  const K_USER = 'cadence.cred_user';
  const K_PIN = 'cadence.pin';
  const K_IDLE = 'cadence.idle_seconds';

  const PBKDF2_ITERATIONS = 150_000;

  let locked = false;
  let hiddenAt = 0;
  let onLockCb = () => {};
  let veilEl = null;

  // ── byte helpers ──────────────────────────────────────────────────────────

  const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

  function b64url(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  // ── The veil ──────────────────────────────────────────────────────────────

  function veil(show) {
    if (!veilEl) veilEl = document.getElementById('veil');
    if (veilEl) veilEl.hidden = !show;
  }

  // ── Biometrics ────────────────────────────────────────────────────────────

  function biometricRegistered() { return !!localStorage.getItem(K_CRED); }

  async function biometricAvailable() {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  /** Register the platform authenticator. Must be called from a user gesture. */
  async function registerBiometric() {
    let userId = localStorage.getItem(K_USER);
    if (!userId) {
      userId = b64url(randomBytes(16));
      localStorage.setItem(K_USER, userId);
    }

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        // rp.id is the full hostname and must stay that way — see CONFIG.RP_ID.
        rp: { id: CONFIG.RP_ID, name: 'Cadence' },
        user: { id: unb64url(userId), name: 'cadence', displayName: 'Cadence' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          // platform + required user verification is what makes the OS show the
          // Face ID sheet rather than offering a security key.
          authenticatorAttachment: 'platform',
          // 'discouraged', not 'required' (the plan's §4.1 said required).
          //
          // A discoverable credential is one iOS can find without being told
          // which, so it shows an account-picker sheet before Face ID — two
          // taps to unlock instead of one. Discovery buys nothing here: this is
          // a single-user app and the credential id is in localStorage, passed
          // as allowCredentials on every unlock. If localStorage is ever
          // cleared, the PIN and the session token go with it, so a
          // discoverable credential would have had nothing left to unlock.
          residentKey: 'discouraged',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: 60_000,
      },
    });
    if (!cred) throw new Error('registration cancelled');
    localStorage.setItem(K_CRED, b64url(cred.rawId));
    return true;
  }

  function forgetBiometric() { localStorage.removeItem(K_CRED); }

  /**
   * Prompt for Face ID / Touch ID. Must be called from a user gesture — Safari
   * refuses a WebAuthn call on page load, which is why the lock screen has an
   * explicit Unlock button rather than prompting automatically.
   *
   * iOS falls back to the device passcode on its own if Face ID fails, so there
   * is no retry logic here on purpose.
   */
  async function unlockWithBiometric() {
    const id = localStorage.getItem(K_CRED);
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: CONFIG.RP_ID,
        userVerification: 'required',
        // Required, not a hint: the credential is non-discoverable, so naming
        // it here is what lets iOS skip the picker and go straight to Face ID.
        allowCredentials: id ? [{ type: 'public-key', id: unb64url(id) }] : [],
        timeout: 60_000,
      },
    });
    if (!assertion) throw new Error('cancelled');
    // Nothing is checked here beyond "the OS said yes". See the header note.
    setLocked(false);
    return true;
  }

  // ── PIN ───────────────────────────────────────────────────────────────────

  function pinSet() { return !!localStorage.getItem(K_PIN); }

  async function derive(pin, salt, iterations) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256
    );
    return b64url(bits);
  }

  async function setPin(pin) {
    if (!/^\d{4,12}$/.test(pin)) throw new Error('PIN must be 4–12 digits');
    const salt = randomBytes(16);
    const hash = await derive(pin, salt, PBKDF2_ITERATIONS);
    // Hashed rather than stored, but this is still a local secret on a device
    // the threat model assumes is in my hands. PBKDF2 buys time against someone
    // reading localStorage, nothing more.
    localStorage.setItem(K_PIN, JSON.stringify({
      salt: b64url(salt), iterations: PBKDF2_ITERATIONS, hash,
    }));
  }

  function clearPin() { localStorage.removeItem(K_PIN); }

  /**
   * Forget every lock method on this device.
   *
   * Needed because a passkey can be deleted from the OS behind the app's back,
   * leaving a credential id that points at nothing — the app believes it has a
   * lock, every unlock attempt fails, and with no PIN there is no way in.
   */
  function reset() {
    forgetBiometric();
    clearPin();
    setLocked(false);
  }

  async function unlockWithPin(pin) {
    const stored = JSON.parse(localStorage.getItem(K_PIN) || 'null');
    if (!stored) throw new Error('no PIN set');
    const hash = await derive(pin, unb64url(stored.salt), stored.iterations);
    if (hash !== stored.hash) throw new Error('wrong PIN');
    setLocked(false);
    return true;
  }

  // ── Lock state ────────────────────────────────────────────────────────────

  function configured() { return biometricRegistered() || pinSet(); }

  function idleSeconds() {
    const v = localStorage.getItem(K_IDLE);
    return v == null ? CONFIG.IDLE_RELOCK_SECONDS : Number(v);
  }
  function setIdleSeconds(s) { localStorage.setItem(K_IDLE, String(s)); }

  function setLocked(v) {
    locked = v;
    if (v) { veil(true); onLockCb(); }
  }

  function lockNow() { if (configured()) setLocked(true); }

  // ── Background handling ───────────────────────────────────────────────────

  function onHide() {
    hiddenAt = Date.now();
    // ⚠️ THIS DOES NOT PROTECT THE APP-SWITCHER SNAPSHOT. Confirmed on device,
    // 2026-09-09: the switcher still shows the real screen. The handler runs —
    // that much is verified — but iOS snapshots the last frame it *painted*,
    // and there is no way to make it paint one first. Toggling opacity on a
    // pre-promoted layer instead of display was tried and changed nothing.
    //
    // A native app gets applicationWillResignActive and a guaranteed chance to
    // render. A web app gets no equivalent, so treat the snapshot as public.
    //
    // Kept anyway because it costs nothing and may hold on some iOS versions,
    // and because raising the veil here means it is already up if the app locks
    // on resume. Do not read its presence as the requirement being met.
    veil(true);
  }

  function onShow() {
    const away = (Date.now() - hiddenAt) / 1000;
    if (configured() && !locked && away > idleSeconds()) {
      setLocked(true);
      return;
    }
    if (!locked) veil(false);
  }

  /**
   * @param {object} opts
   * @param {Function} opts.onLock called whenever the app becomes locked, so
   *        the caller can swap to the lock screen.
   */
  function init({ onLock }) {
    onLockCb = onLock || (() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) onHide(); else onShow();
    });
    // pagehide covers the cases visibilitychange misses on iOS — a swipe to the
    // home screen, and the bfcache path.
    addEventListener('pagehide', onHide);
    // A fresh load is always locked when a method is configured. Nothing
    // persists an "unlocked" state; there is no way to reach the app by
    // reloading it.
    locked = configured();
  }

  return {
    init, veil,
    get locked() { return locked; },
    lockNow, unlocked: () => setLocked(false),
    configured, idleSeconds, setIdleSeconds,
    biometricAvailable, biometricRegistered, registerBiometric, forgetBiometric,
    unlockWithBiometric,
    pinSet, setPin, clearPin, unlockWithPin, reset,
  };
})();
