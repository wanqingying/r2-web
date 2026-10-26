const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** @typedef {{ accountId: string; bucket: string; customDomain: string | null }} SessionInfo */
/** @typedef {{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: number }} SessionCredentials */
/** @typedef {{ kind: 'ok'; data: any } | { kind: 'unauthorized' } | { kind: 'absent' } | { kind: 'error' }} SessionResult */

/**
 * Talks to the deployment's `/api/session` endpoint.
 *
 * Three states:
 * - `worker`: the page is served by a Worker that holds the R2 credentials.
 * - `login`: a Worker is present but this browser has no valid session.
 * - `local`: static hosting, the app keeps using credentials from localStorage.
 */
class SessionManager {
  /** @type {'unknown' | 'worker' | 'login' | 'local'} */
  #state = 'unknown'
  /** @type {SessionCredentials | null} */
  #credentials = null
  /** @type {SessionInfo | null} */
  #info = null
  /** @type {'unauthorized' | 'server' | null} */
  #reason = null
  /** @type {Promise<void> | null} */
  #pending = null

  get state() {
    return this.#state
  }

  get reason() {
    return this.#reason
  }

  /** @returns {SessionInfo | null} */
  get info() {
    return this.#info
  }

  /** @returns {SessionCredentials | null} */
  get credentials() {
    return this.#credentials
  }

  isWorkerMode() {
    return this.#state === 'worker'
  }

  /** @returns {Promise<'worker' | 'login' | 'local'>} */
  async bootstrap() {
    const result = await this.#request('/api/session', 'GET')
    if (result.kind === 'ok') {
      this.#apply(result.data)
      return 'worker'
    }
    if (result.kind === 'absent') {
      this.#state = 'local'
      return 'local'
    }

    this.#state = 'login'
    this.#reason = result.kind === 'error' ? 'server' : 'unauthorized'
    return 'login'
  }

  /** @param {string} password @returns {Promise<boolean>} */
  async login(password) {
    const result = await this.#request('/api/login', 'POST', { password })
    if (result.kind === 'ok') {
      this.#reason = null
      this.#apply(result.data)
      return true
    }
    if (result.kind === 'unauthorized') return false
    throw new Error('LOGIN_UNAVAILABLE')
  }

  async logout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      /* the cookie is cleared on reload anyway */
    }
    this.#credentials = null
    this.#info = null
    this.#state = 'login'
    this.#reason = 'unauthorized'
  }

  /**
   * Refresh credentials shortly before they expire. Called before every S3
   * request, so long uploads keep working across credential rotations.
   */
  async ensure() {
    if (this.#state !== 'worker') return
    if (this.#credentials && this.#credentials.expiresAt - REFRESH_MARGIN_MS > Date.now()) return
    if (this.#pending) return this.#pending

    this.#pending = this.#refresh().finally(() => {
      this.#pending = null
    })
    return this.#pending
  }

  async #refresh() {
    const result = await this.#request('/api/session', 'GET')
    if (result.kind === 'ok') {
      this.#apply(result.data)
      return
    }
    if (result.kind === 'unauthorized') {
      this.#credentials = null
      this.#state = 'login'
      this.#reason = 'unauthorized'
      throw new Error('SESSION_EXPIRED')
    }
    if (this.#credentials && this.#credentials.expiresAt > Date.now()) return
    throw new Error('SESSION_REFRESH_FAILED')
  }

  /** @param {any} data */
  #apply(data) {
    this.#state = 'worker'
    this.#info = {
      accountId: String(data.accountId ?? ''),
      bucket: String(data.bucket ?? ''),
      customDomain: data.customDomain ? String(data.customDomain) : null,
    }
    this.#credentials = {
      accessKeyId: String(data.credentials.accessKeyId),
      secretAccessKey: String(data.credentials.secretAccessKey),
      sessionToken: String(data.credentials.sessionToken),
      expiresAt: Date.now() + Number(data.credentials.expiresIn ?? 3600) * 1000,
    }
  }

  /**
   * @param {string} path
   * @param {'GET' | 'POST'} method
   * @param {Record<string, unknown>} [body]
   * @returns {Promise<SessionResult>}
   */
  async #request(path, method, body) {
    /** @type {Response} */
    let response
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch {
      return { kind: 'error' }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return { kind: 'absent' }
    if (response.status === 401) return { kind: 'unauthorized' }
    if (!response.ok) return { kind: 'error' }

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (data?.mode !== 'worker' || !data.credentials?.sessionToken) return { kind: 'absent' }
    return { kind: 'ok', data }
  }
}

export { SessionManager }
