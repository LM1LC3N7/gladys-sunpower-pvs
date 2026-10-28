// -----------------------------------------------------------------------------
// The errors of the PVS. A PvsError message never holds the address, the
// password, the serial number, the session cookie nor a value of the PVS: it
// may be logged and shown.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  /** No TCP connection (refused, no route, DNS). */
  UNREACHABLE: 'unreachable',
  /** No complete answer within the deadline. */
  TIMEOUT: 'timeout',
  /** The session changed (a new configuration, a stop) before the request was written. */
  LATE: 'late',
  /** An answer above the size cap. */
  TOO_LARGE: 'too_large',
  /** Something answered, but not the varserver API (another protocol, not JSON, wrong shape). */
  BAD_ANSWER: 'bad_answer',
  /** An HTTP status this code does not expect (`status`). */
  HTTP: 'http',
  /** HTTP 429: the PVS asks to slow down (`retryAfter`, ms). */
  RATE_LIMITED: 'rate_limited',
  /** HTTP 5xx (`status`, `retryAfter`). */
  SERVER: 'server',
  /** The login was refused (HTTP 401/403 on /auth?login): final until the password changes. */
  CREDENTIALS: 'credentials',
  /** The variables were refused on a session just opened (not a refusal of the password). */
  ACCESS: 'access',
  /** No password typed and the PVS does not give its serial number without a session. */
  NO_SERIAL: 'no_serial',
  /** A redirection: never followed. */
  REDIRECT: 'redirect',
  /** The certificate is not the one pinned (`fingerprint` holds the one met). */
  CERTIFICATE: 'certificate',
  /** The certificate is not the fingerprint typed in the configuration (`fingerprint`). */
  CERTIFICATE_TYPED: 'certificate_typed',
  /** No pin, and /data cannot keep one: nothing is sent (`reason`: 'unreadable' | 'unwritable'). */
  PIN_UNAVAILABLE: 'pin_unavailable',
  /** A TLS handshake the PVS refused. */
  TLS: 'tls',
});

export class PvsError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message safe to log
   * @param {{ notSent?: boolean, status?: number, retryAfter?: number, fingerprint?: string, reason?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PvsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** The certificate failures: nothing is sent until the user acts (or the pinned one comes back). */
export const isCertificate = (err) =>
  err?.code === CODES.CERTIFICATE ||
  err?.code === CODES.CERTIFICATE_TYPED ||
  err?.code === CODES.PIN_UNAVAILABLE;
