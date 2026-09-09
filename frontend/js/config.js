// Build stamp and client-side constants. deploy.sh rewrites VERSION in place.
const CONFIG = {
  VERSION: '20260908_2055',

  // WebAuthn relying-party id (plan §4.1). This MUST be the full hostname.
  //
  // Setting it to the registrable domain (`mishabhi.workers.dev`) would be
  // accepted by the Public Suffix List and would scope the credential to every
  // other worker on that subdomain — including the Focus PWA — which is both
  // wrong and a small privacy leak. Reading it from location.hostname is what
  // guarantees it can never drift into that.
  //
  // The credential binds to this exact host, so moving to a custom domain later
  // means re-registering. That is a ~30 second annoyance for one user.
  RP_ID: location.hostname,

  // How long the app may sit in the background before it re-locks, so a quick
  // app-switch mid-log isn't punished. Overridable in Settings.
  IDLE_RELOCK_SECONDS: 60,

  // Milliseconds the acknowledgement screen stays up after a save. Long enough
  // to register, short enough that it is never somewhere to sit.
  DONE_MS: 900,
};
