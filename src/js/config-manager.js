import { STORAGE_KEY, THEME_KEY, LANG_KEY, VIEW_KEY, DENSITY_KEY, SORT_BY_KEY, SORT_ORDER_KEY } from './constants.js'

/** @typedef {{ accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket?: string; filenameTpl?: string; filenameTplScope?: string; customDomain?: string; bucketAccess?: 'public' | 'private'; compressMode?: string; compressLevel?: string; tinifyKey?: string; uploadConcurrency?: number }} AppConfig */
/** @typedef {AppConfig & { theme?: string; lang?: string; view?: string; density?: string; sortBy?: string; sortOrder?: string }} SharePayload */
/** @typedef {{ accountId: string; bucket: string; customDomain: string | null }} SessionInfo */

class ConfigManager {
  /** @type {SessionInfo | null} */
  #session = null

  /** @param {SessionInfo} info */
  applySession(info) {
    this.#session = info
  }

  clearSession() {
    this.#session = null
  }

  isWorkerMode() {
    return !!this.#session
  }

  /** @returns {AppConfig} */
  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') || {}
    } catch {
      return /** @type {AppConfig} */ ({})
    }
  }

  /** @param {AppConfig} cfg */
  save(cfg) {
    if (!this.#session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
      return
    }
    // Worker mode never persists credentials: the Worker mints them per session.
    const { accountId, accessKeyId, secretAccessKey, bucket, ...preferences } = cfg
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  }

  /** @returns {AppConfig} */
  get() {
    const local = this.load()
    if (!this.#session) return local
    return {
      ...local,
      accountId: this.#session.accountId,
      bucket: this.#session.bucket,
      customDomain: this.#session.customDomain ?? local.customDomain,
    }
  }

  clear() {
    localStorage.removeItem(STORAGE_KEY)
  }

  isValid() {
    if (this.#session) return true
    const c = this.load()
    return !!(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket)
  }

  getEndpoint() {
    const c = this.get()
    return `https://${c.accountId}.r2.cloudflarestorage.com`
  }

  getBucketUrl() {
    const c = this.get()
    return `${this.getEndpoint()}/${c.bucket}`
  }

  toBase64() {
    /** @type {SharePayload} */
    const payload = {
      ...this.load(),
      theme: localStorage.getItem(THEME_KEY) || undefined,
      lang: localStorage.getItem(LANG_KEY) || undefined,
      view: localStorage.getItem(VIEW_KEY) || undefined,
      density: localStorage.getItem(DENSITY_KEY) || undefined,
      sortBy: localStorage.getItem(SORT_BY_KEY) || undefined,
      sortOrder: localStorage.getItem(SORT_ORDER_KEY) || undefined,
    }
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
  }

  /** @param {string} b64 @returns {boolean} */
  loadFromBase64(b64) {
    try {
      const json = decodeURIComponent(escape(atob(b64)))
      /** @type {SharePayload} */
      const payload = JSON.parse(json)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false

      const { theme, lang, view, density, sortBy, sortOrder, ...r2Config } = payload
      if (theme) localStorage.setItem(THEME_KEY, theme)
      if (lang) localStorage.setItem(LANG_KEY, lang)
      if (view) localStorage.setItem(VIEW_KEY, view)
      if (density) localStorage.setItem(DENSITY_KEY, density)
      if (sortBy) localStorage.setItem(SORT_BY_KEY, sortBy)
      if (sortOrder) localStorage.setItem(SORT_ORDER_KEY, sortOrder)

      if (Object.values(r2Config).some(Boolean)) this.save(r2Config)
      return true
    } catch {
      /* invalid base64 or JSON */
    }
    return false
  }

  getShareUrl() {
    const b64 = this.toBase64()
    const url = new URL(window.location.href)
    url.searchParams.set('config', b64)
    url.hash = ''
    return url.toString()
  }
}

export { ConfigManager }
