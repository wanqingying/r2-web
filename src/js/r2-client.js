import { AwsClient } from 'aws4fetch'
import { PAGE_SIZE } from './constants.js'
import { encodeS3Key } from './utils.js'
import { ConfigManager } from './config-manager.js'

/** @typedef {{ key: string; isFolder: boolean; size?: number; lastModified?: string }} FileItem */
/** @typedef {{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: number }} SessionCredentials */
/** @typedef {{ isWorkerMode: () => boolean; ensure: () => Promise<void>; credentials: SessionCredentials | null }} SessionManager */

/** @param {number} status */
function httpError(status) {
  if (status === 401) return new Error('HTTP_401')
  if (status === 403) return new Error('HTTP_403')
  if (status === 404) return new Error('HTTP_404')
  return new Error(`HTTP ${status}`)
}

class R2Client {
  /** @type {AwsClient | null} */
  #client = null
  /** @type {ConfigManager | null} */
  #config = null
  /** @type {SessionManager | null} */
  #session = null
  /** Stamp of the credentials currently in #client. @type {string} */
  #stamp = ''

  /**
   * @param {ConfigManager} configManager
   * @param {SessionManager | null} [sessionManager]
   */
  init(configManager, sessionManager = null) {
    this.#config = configManager
    this.#session = sessionManager
    this.#buildClient()
  }

  #buildClient() {
    const session = this.#session
    if (session?.isWorkerMode()) {
      const creds = /** @type {SessionCredentials} */ (session.credentials)
      this.#client = new AwsClient({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        service: 's3',
        region: 'auto',
      })
      this.#stamp = creds.sessionToken
      return
    }

    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    this.#client = new AwsClient({
      accessKeyId: /** @type {string} */ (cfg.accessKeyId),
      secretAccessKey: /** @type {string} */ (cfg.secretAccessKey),
      service: 's3',
      region: 'auto',
    })
    this.#stamp = ''
  }

  /** Refresh managed credentials when they are close to expiry, then hand back the signer. @returns {Promise<AwsClient>} */
  async #ready() {
    const session = this.#session
    if (session?.isWorkerMode()) {
      await session.ensure()
      if (this.#stamp !== session.credentials?.sessionToken) this.#buildClient()
    }
    return /** @type {AwsClient} */ (this.#client)
  }

  /** @param {string} key @param {Record<string, string>} [extra] */
  #proxyUrl(key, extra = {}) {
    const url = new URL('/api/object', window.location.origin)
    url.searchParams.set('key', key)
    for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value)
    return url.toString()
  }

  /** @param {string} [prefix] @param {string} [continuationToken] */
  async listObjects(prefix = '', continuationToken = '') {
    const client = await this.#ready()
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('delimiter', '/')
    url.searchParams.set('max-keys', String(PAGE_SIZE))
    if (prefix) url.searchParams.set('prefix', prefix)
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

    const res = await client.fetch(url.toString())
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }

    const text = await res.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')

    /** @type {FileItem[]} */
    const folders = [...doc.querySelectorAll('CommonPrefixes > Prefix')].map((el) => ({
      key: el.textContent ?? '',
      isFolder: true,
    }))

    /** @type {FileItem[]} */
    const files = [...doc.querySelectorAll('Contents')]
      .map((el) => ({
        key: el.querySelector('Key')?.textContent ?? '',
        size: parseInt(el.querySelector('Size')?.textContent ?? '0', 10),
        lastModified: el.querySelector('LastModified')?.textContent ?? '',
        isFolder: false,
      }))
      .filter((f) => f.key !== prefix)

    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true'
    const nextToken = doc.querySelector('NextContinuationToken')?.textContent || ''

    return { folders, files, isTruncated, nextToken }
  }

  /**
   * 检查对象是否存在，使用 ListObjectsV2 避免 HEAD 404 污染控制台
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    const client = await this.#ready()
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('max-keys', '1')
    url.searchParams.set('prefix', key)
    const res = await client.fetch(url.toString())
    if (!res.ok) return false
    const text = await res.text()
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    return [...doc.querySelectorAll('Contents > Key')].some((el) => el.textContent === key)
  }

  /** @param {string} key @param {string} contentType @param {Blob} body */
  async putObjectSigned(key, contentType, body) {
    const client = await this.#ready()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const req = await client.sign(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    })
    return { url: req.url, headers: Object.fromEntries(req.headers.entries()) }
  }

  /** @param {string} key @param {string} contentType */
  async createMultipartUpload(key, contentType) {
    const client = await this.#ready()
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploads', '')
    const res = await client.fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const uploadId = doc.querySelector('UploadId')?.textContent
    if (!uploadId) throw new Error('R2 did not return a multipart upload ID')
    return uploadId
  }

  /** @param {string} key @param {string} uploadId @param {number} partNumber @param {Blob} body */
  async uploadPartSigned(key, uploadId, partNumber, body) {
    const client = await this.#ready()
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('partNumber', String(partNumber))
    url.searchParams.set('uploadId', uploadId)
    const req = await client.sign(url.toString(), {
      method: 'PUT',
      body,
    })
    return { url: req.url, headers: Object.fromEntries(req.headers.entries()) }
  }

  /** @param {string} key @param {string} uploadId @param {{ partNumber: number; etag: string }[]} parts */
  async completeMultipartUpload(key, uploadId, parts) {
    const client = await this.#ready()
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploadId', uploadId)
    const body = `<CompleteMultipartUpload>${parts
      .map(({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`
    const res = await client.fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    })
    const text = await res.text()
    if (!res.ok || new DOMParser().parseFromString(text, 'application/xml').querySelector('Error')) {
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} uploadId */
  async abortMultipartUpload(key, uploadId) {
    const client = await this.#ready()
    const url = new URL(`${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`)
    url.searchParams.set('uploadId', uploadId)
    const res = await client.fetch(url.toString(), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
  }

  /**
   * @param {string} [keyMarker]
   * @param {string} [uploadIdMarker]
   */
  async listMultipartUploads(keyMarker = '', uploadIdMarker = '') {
    const client = await this.#ready()
    const url = new URL(/** @type {ConfigManager} */ (this.#config).getBucketUrl())
    url.searchParams.set('uploads', '')
    url.searchParams.set('max-uploads', '1000')
    if (keyMarker) url.searchParams.set('key-marker', keyMarker)
    if (uploadIdMarker) url.searchParams.set('upload-id-marker', uploadIdMarker)

    const res = await client.fetch(url.toString())
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
    const uploads = [...doc.querySelectorAll('Upload')]
      .map((item) => ({
        key: item.querySelector('Key')?.textContent ?? '',
        uploadId: item.querySelector('UploadId')?.textContent ?? '',
      }))
      .filter((item) => item.key && item.uploadId)

    return {
      uploads,
      isTruncated: doc.querySelector('IsTruncated')?.textContent === 'true',
      nextKeyMarker: doc.querySelector('NextKeyMarker')?.textContent ?? '',
      nextUploadIdMarker: doc.querySelector('NextUploadIdMarker')?.textContent ?? '',
    }
  }

  async abortAllMultipartUploads() {
    /** @type {{ key: string; uploadId: string }[]} */
    const uploads = []
    let keyMarker = ''
    let uploadIdMarker = ''

    while (true) {
      const page = await this.listMultipartUploads(keyMarker, uploadIdMarker)
      uploads.push(...page.uploads)
      if (!page.isTruncated) break
      if (page.nextKeyMarker === keyMarker && page.nextUploadIdMarker === uploadIdMarker) {
        throw new Error('R2 returned invalid multipart upload pagination markers')
      }
      keyMarker = page.nextKeyMarker
      uploadIdMarker = page.nextUploadIdMarker
    }

    let nextIndex = 0
    let succeeded = 0
    let failed = 0
    const worker = async () => {
      while (nextIndex < uploads.length) {
        const upload = uploads[nextIndex++]
        let cleaned = false
        for (let attempt = 0; attempt < 3 && !cleaned; attempt++) {
          try {
            await this.abortMultipartUpload(upload.key, upload.uploadId)
            cleaned = true
          } catch {
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
          }
        }
        if (cleaned) succeeded++
        else failed++
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, uploads.length) }, worker))
    return { total: uploads.length, succeeded, failed }
  }

  /** @param {string} key */
  async getObject(key) {
    if (this.#session?.isWorkerMode()) {
      const res = await fetch(this.#proxyUrl(key), { credentials: 'same-origin' })
      if (!res.ok) throw httpError(res.status)
      return res
    }

    const client = await this.#ready()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await client.fetch(url)
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
    return res
  }

  /** @param {string} key */
  async getPresignedUrl(key) {
    if (this.#session?.isWorkerMode()) return this.#proxyUrl(key)

    const client = await this.#ready()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const signed = await client.sign(url, {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }

  /** @param {string} key @param {string} filename */
  async getDownloadUrl(key, filename) {
    if (this.#session?.isWorkerMode()) return this.#proxyUrl(key, { download: '1', name: filename })

    const client = await this.#ready()
    const base = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const url = new URL(base)
    url.searchParams.set('response-content-disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    const signed = await client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }

  /** @param {string} key */
  getPublicUrl(key) {
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    if (cfg.customDomain && cfg.bucketAccess !== 'private') {
      return `${cfg.customDomain}/${encodeS3Key(key)}`
    }
    return null
  }

  /** @param {string} key */
  async headObject(key) {
    const client = await this.#ready()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await client.fetch(url, { method: 'HEAD' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {
      contentType: res.headers.get('content-type'),
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      lastModified: res.headers.get('last-modified'),
      etag: res.headers.get('etag'),
    }
  }

  /** @param {string} key */
  async deleteObject(key) {
    const client = await this.#ready()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await client.fetch(url, { method: 'DELETE' })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} src @param {string} dest */
  async copyObject(src, dest) {
    const client = await this.#ready()
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(dest)}`
    const res = await client.fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(src)}`,
      },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} key @param {string} contentType */
  async updateContentType(key, contentType) {
    const client = await this.#ready()
    const cfg = /** @type {ConfigManager} */ (this.#config).get()
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await client.fetch(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': `/${cfg.bucket}/${encodeS3Key(key)}`,
        'x-amz-metadata-directive': 'REPLACE',
        'Content-Type': contentType,
      },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }

  /** @param {string} prefix */
  async createFolder(prefix) {
    const client = await this.#ready()
    const key = prefix.endsWith('/') ? prefix : prefix + '/'
    const url = `${/** @type {ConfigManager} */ (this.#config).getBucketUrl()}/${encodeS3Key(key)}`
    const res = await client.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Length': '0' },
      body: '',
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('HTTP_401')
      if (res.status === 403) throw new Error('HTTP_403')
      if (res.status === 404) throw new Error('HTTP_404')
      throw new Error(`HTTP ${res.status}`)
    }
  }
}

export { R2Client }
