/**
 * R2 Web — credentials gateway.
 *
 * Holds the R2 API token server-side and mints short-lived, scoped credentials
 * for the browser (R2 temporary credentials, signed locally as a JWT).
 * Access is gated by a single ACCESS_TOKEN that can be used either as a
 * `?token=` share link or as a password on the login screen.
 */

const SESSION_COOKIE = '__Host-r2w'
const DEFAULT_CREDENTIAL_TTL = 3600
const DEFAULT_SESSION_TTL = 604800

/** S3 actions the browser needs for the full file manager. */
const ACTIONS = [
  'GetObject',
  'HeadObject',
  'ListObjectsV2',
  'PutObject',
  'DeleteObject',
  'CopyObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
  'ListMultipartUploads',
  'ListParts',
]

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    const url = new URL(request.url)

    // Share link: trade ?token= for a cookie, then drop the token from the URL
    // so it never reaches the rendered page, browser history or Referer.
    if (url.searchParams.has('token')) {
      return handleTokenLink(request, env, url)
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url)
    }

    const response = await env.ASSETS.fetch(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') return response

    const headers = new Headers(response.headers)
    headers.set('x-content-type-options', 'nosniff')
    headers.set('x-frame-options', 'DENY')
    headers.set('referrer-policy', 'no-referrer')
    return new Response(response.body, { status: response.status, headers })
  },
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleTokenLink(request, env, url) {
  const token = url.searchParams.get('token') ?? ''
  const clean = new URL(url)
  clean.searchParams.delete('token')

  const ok = token.length > 0 && (await equalSecret(token, env.ACCESS_TOKEN))
  if (!ok) {
    clean.searchParams.set('auth', 'invalid')
    return new Response(null, { status: 302, headers: redirectHeaders(clean, null) })
  }

  const cookie = await createSessionCookie(env)
  return new Response(null, { status: 302, headers: redirectHeaders(clean, cookie) })
}

/**
 * @param {URL} url
 * @param {string | null} cookie
 */
function redirectHeaders(url, cookie) {
  /** @type {Record<string, string>} */
  const headers = {
    location: url.pathname + url.search,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  }
  if (cookie) headers['set-cookie'] = cookie
  return headers
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleApi(request, env, url) {
  if (!env.ACCESS_TOKEN || !env.R2_ACCOUNT_ID || !env.R2_BUCKET || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return json({ error: 'server_not_configured' }, 500)
  }

  switch (url.pathname) {
    case '/api/session':
      if (request.method !== 'GET') return methodNotAllowed()
      return handleSession(request, env)

    case '/api/login':
      if (request.method !== 'POST') return methodNotAllowed()
      return handleLogin(request, env)

    case '/api/logout':
      if (request.method !== 'POST') return methodNotAllowed()
      return new Response(null, {
        status: 204,
        headers: {
          'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          'cache-control': 'no-store',
        },
      })

    case '/api/object':
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed()
      return handleObject(request, env, url)

    default:
      return json({ error: 'not_found' }, 404)
  }
}

/** @param {Request} request @param {Env} env */
async function handleSession(request, env) {
  const session = await readSession(request, env)
  if (!session) return json({ error: 'unauthorized' }, 401)
  return sessionResponse(env)
}

/** @param {Request} request @param {Env} env */
async function handleLogin(request, env) {
  let password = ''
  try {
    const body = await request.text()
    if (body.length > 4096) return json({ error: 'payload_too_large' }, 413)
    password = String(JSON.parse(body)?.password ?? '')
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }

  if (!(await equalSecret(password, env.ACCESS_TOKEN))) {
    return json({ error: 'invalid_token' }, 401)
  }

  const cookie = await createSessionCookie(env)
  const response = await sessionResponse(env)
  const headers = new Headers(response.headers)
  headers.set('set-cookie', cookie)
  return new Response(response.body, { status: response.status, headers })
}

/**
 * Mint temporary R2 credentials for the current session.
 * @param {Env} env
 */
async function sessionResponse(env) {
  const ttl = credentialTtl(env)
  const endTime = Math.floor(Date.now() / 1000) + ttl
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`

  /** @type {Record<string, unknown>} */
  const claims = {
    bucket: env.R2_BUCKET,
    actions: ACTIONS,
    iss: env.R2_ACCESS_KEY_ID,
    sub: env.R2_ACCOUNT_ID,
    aud: host,
    iat: Math.floor(Date.now() / 1000),
    exp: endTime,
  }

  const jwt = await signJwt(claims, env.R2_SECRET_ACCESS_KEY)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jwt))
  const secretAccessKey = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')

  return json({
    mode: 'worker',
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    customDomain: (env.R2_CUSTOM_DOMAIN ?? '').replace(/\/+$/, '') || null,
    credentials: {
      // R2 reuses the parent access key id for temporary credentials.
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey,
      sessionToken: btoa(`jwt/${jwt}`),
      expiresIn: ttl,
    },
  })
}

/**
 * Stream an object through the Worker. Media elements cannot send signature
 * headers, and presigned URLs are avoided entirely so this path stays the only
 * way to read object bodies.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleObject(request, env, url) {
  const session = await readSession(request, env)
  if (!session) return json({ error: 'unauthorized' }, 401)

  const key = url.searchParams.get('key') ?? ''
  if (!key) return json({ error: 'missing_key' }, 400)

  const hasRange = request.headers.has('range')
  const object = await env.BUCKET.get(key, hasRange ? { range: request.headers } : undefined)
  if (!object) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('cache-control', 'private, no-store')

  if (url.searchParams.get('download') === '1') {
    const filename = url.searchParams.get('name') || key.split('/').pop() || 'download'
    headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  }

  const range = object.range
  if (hasRange && range && ('offset' in range || 'suffix' in range)) {
    const start = 'offset' in range ? range.offset : Math.max(0, object.size - range.suffix)
    const length = 'offset' in range ? (range.length ?? object.size - start) : object.size - start
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`)
    headers.set('content-length', String(length))
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers })
  }

  headers.set('content-length', String(object.size))
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers })
}

/** @param {Env} env */
function credentialTtl(env) {
  const configured = Number(env.CREDENTIAL_TTL)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_CREDENTIAL_TTL
  return Math.min(Math.max(configured, 300), 604800)
}

/** @param {Env} env */
function sessionTtl(env) {
  const configured = Number(env.SESSION_TTL)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SESSION_TTL
  return Math.min(Math.max(configured, 3600), 2592000)
}

/** @param {Request} request @param {Env} env */
async function readSession(request, env) {
  const raw = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!raw) return null

  const [body, signature] = raw.split('.')
  if (!body || !signature) return null
  if (!(await equalSecret(signature, await hmacB64Url(signingKey(env), body)))) return null

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(body)))
    if (typeof payload?.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

/** @param {Env} env */
async function createSessionCookie(env) {
  const ttl = sessionTtl(env)
  const exp = Math.floor(Date.now() / 1000) + ttl
  const body = b64UrlEncode(JSON.stringify({ exp }))
  const signature = await hmacB64Url(signingKey(env), body)
  return `${SESSION_COOKIE}=${body}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`
}

/** @param {Env} env */
function signingKey(env) {
  return env.SESSION_SECRET || env.ACCESS_TOKEN
}

/**
 * @param {Record<string, unknown>} claims
 * @param {string} secret
 */
async function signJwt(claims, secret) {
  const header = b64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64UrlEncode(JSON.stringify(claims))
  const signature = await hmacB64Url(secret, `${header}.${payload}`)
  return `${header}.${payload}.${signature}`
}

/**
 * @param {string} key
 * @param {string} message
 */
async function hmacB64Url(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  return b64UrlEncode(signature)
}

/**
 * Compare two secrets by their digests, so the loop does not leak length or
 * prefix information about the expected value.
 * @param {string} provided
 * @param {string | undefined} expected
 */
async function equalSecret(provided, expected) {
  if (!expected) return false
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

/** @param {string | ArrayBuffer} input */
function b64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} value */
function b64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * @param {string | null} header
 * @param {string} name
 */
function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/**
 * @param {unknown} data
 * @param {number} status
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function methodNotAllowed() {
  return json({ error: 'method_not_allowed' }, 405)
}

/**
 * @typedef {object} Env
 * @property {{ fetch: (request: Request) => Promise<Response> }} ASSETS
 * @property {{ get: (key: string, options?: { range?: Headers }) => Promise<any> }} BUCKET
 * @property {string} R2_ACCOUNT_ID
 * @property {string} R2_BUCKET
 * @property {string} [R2_CUSTOM_DOMAIN]
 * @property {string} R2_ACCESS_KEY_ID
 * @property {string} R2_SECRET_ACCESS_KEY
 * @property {string} ACCESS_TOKEN
 * @property {string} [SESSION_SECRET]
 * @property {string} [CREDENTIAL_TTL]
 * @property {string} [SESSION_TTL]
 */
