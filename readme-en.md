![93c1205d.png](https://image.viki.moe/github/93c1205d.png)

**[中文](./readme.md) | English**

# R2 Web

📁 A lightweight, elegant, pure-browser Cloudflare R2 file manager. Everything happens right in your browser.

> Featured in _[Tech Enthusiast Weekly (Issue 387)][ruanyifeng-weekly]_ and [HelloGitHub (Issue 123)][hellogithub-123].

## Live Demo

Follow the [Quick Start](#quick-start) to configure R2 CORS, then open **[r2.viki.moe](https://r2.viki.moe)**. Credentials stay in your browser by default; the bundled Worker can hold them instead — see [Worker deployment](#worker-deployment-optional-server-held-credentials--access-control).

## Why R2 Web?

The Cloudflare dashboard works for basic operations, but browsing, moving, renaming, and uploading many files can be cumbersome. Desktop clients require installation, while CLI tools are not ideal for everyone. R2 Web provides an instant, cross-platform management interface built specifically for R2.

### What makes it different

| Advantage | Details |
| --- | --- |
| **Direct, client-side access** | The browser calls the R2 S3 API directly; files and credentials never pass through a third-party backend |
| **Zero build, zero framework** | `src` is the deployable artifact, built on native Web APIs for easy auditing and self-hosting |
| **Large-file workflow** | Automatic multipart uploads with pause/resume, live speed and byte progress, up to 1 TiB per file |
| **Focused file management** | Directory browsing, previews, sorting, multi-select, copy, move, rename, and recursive delete |
| **Image-hosting friendly** | Drag/paste upload, filename templates, local image compression, and Markdown/HTML link copying |
| **Cross-platform UX** | PWA, dark mode, and zh / zh_TW / en / ja localization |

> R2 Web is not a replacement for complex permission management, automation, or API integration. Use the Cloudflare dashboard, official SDK/CLI, or rclone for those workflows and for files larger than 1 TiB.

## Features

| Category | Capabilities |
| --- | --- |
| **Browse & manage** | Paginated directories, lazy thumbnails, name/date/size sorting, batch copy/move/delete |
| **Upload** | Picker, drag, paste, concurrency, automatic multipart, pause/resume, conflict handling, 1 TiB limit |
| **Filename templates** | `[name]`, `[ext]`, `[hash:N]`, date, timestamp, UUID, and directory templates |
| **Image compression** | Local WebAssembly compression for JPEG, PNG, WebP, and AVIF; optional Tinify support |
| **Preview & share** | Image, video, audio, and text previews; public/presigned URLs, QR, Markdown, and HTML |
| **Personalization** | Grid/list views, density controls, light/dark themes, localization, and PWA |

## Screenshots

![9392ee.png](https://image.viki.moe/github/9392ee.png)

![ea7dd6.png](https://image.viki.moe/github/ea7dd6.png)

## Quick Start

### 1. Configure R2 Bucket CORS

In Cloudflare, go to **R2 → Bucket → Settings → CORS Policy**:

```json
[
  {
    "AllowedOrigins": ["https://r2.viki.moe"],
    "AllowedMethods": ["GET", "POST", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

For self-hosting, replace `AllowedOrigins` with your domain. Exposing `ETag` is required to complete multipart uploads.

### 2. Create and enter credentials

Create an R2 API token scoped to the target bucket. At [r2.viki.moe](https://r2.viki.moe), enter the Account ID, Access Key ID, Secret Access Key, and Bucket Name.

### 3. Start managing files

Drag, paste, or click to upload. Right-click files to preview, copy links, move, rename, or delete. For image hosting, enable filename templates and local image compression.

## Self-Hosting

R2 Web is a static site. Deploy the repository's `src` directory as-is.

| Platform | One-click deploy |
| --- | --- |
| Vercel | [![Deploy with Vercel](https://vercel.com/button)][vercel-deploy] |
| Netlify | [![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)][netlify-deploy] |
| Cloudflare Pages | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)][cloudflare-deploy] |

After deployment, add the new domain to your R2 CORS `AllowedOrigins`.

## Worker Deployment (optional: server-held credentials + access control)

A static deployment asks every visitor for R2 credentials. The bundled Cloudflare Worker keeps them on the server and hands the browser **1-hour temporary credentials** (R2 temporary credentials, signed locally as a JWT), so visitors only need one access token.

- Browsers keep talking to R2 directly: uploads, listings and deletes never pass through the Worker, so 1 TiB multipart uploads are unaffected.
- Visitors enter through `https://your-domain/?token=xxx` (traded for an HttpOnly cookie, token stripped from the URL) or by typing the same token on the access screen. Sessions last 7 days by default; rotating the token invalidates every session.
- Previews and downloads are streamed through the Worker (Range supported), because `<video>` and `<img>` cannot send signature headers.
- Static deployments are untouched: when `/api/session` does not answer with JSON, the app falls back to local credentials.

### 1. Create an R2 API token

Use the **Object Read & Write** permission, scoped to the target bucket.

### 2. Fill in `wrangler.jsonc`

Static and Worker deployments share this single config: `main` points at the Worker, `assets` at the static files, and the R2 binding and variables live here too. Fill in your bucket and Account ID (the Git integration reads this file on every build):

```jsonc
{
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "your-bucket" }],
  "vars": {
    "R2_ACCOUNT_ID": "your-account-id",
    "R2_BUCKET": "your-bucket",
    "R2_CUSTOM_DOMAIN": ""
  }
}
```

### 3. Set secrets and deploy

```bash
openssl rand -hex 24   # generate the access token, avoid weak passwords

npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler deploy
```

Add the Worker domain to your R2 CORS `AllowedOrigins`. `AllowedHeaders` must be `*` so the new `X-Amz-Security-Token` header passes; keep `ETag` in `ExposeHeaders`.

### 4. Share

Send `https://your-domain/?token=<ACCESS_TOKEN>`, or just the domain and let people type the token. Optionally run `npx wrangler secret put SESSION_SECRET` to sign cookies with a key separate from the access token; rotating it also signs everyone out.

> [!NOTE]
> Everyone shares that one token, so everyone is an admin. Per-prefix, read-only and expiring share links are the next step — R2 temporary credentials already support `prefixPaths` and `actions`.

Local development:

```bash
cp .dev.vars.example .dev.vars   # fill in the same values
npx wrangler dev
```

## Common Configuration

### Filename templates

- `[name]_[hash:6].[ext]` — original name plus content hash
- `images/[date:YYYY/MM/DD]/[uuid].[ext]` — date-based directories
- `backup/[timestamp]-[name].[ext]` — timestamped backups

### Configuration sharing

Generate a configuration link or QR code to sync settings between devices.

> [!CAUTION]
> Shared configuration contains R2 credentials. Send it only through trusted channels and never publish it publicly.

## Local Development

```bash
git clone https://github.com/vikiboss/r2-web.git
cd r2-web
pnpm install

npx serve src
# or
python3 -m http.server 5500 --directory src
```

No build is required. Dependencies are primarily used through browser Import Maps and for local type checking. See [AGENTS.md](./AGENTS.md) for development conventions.

## FAQ

**Are my credentials safe?**  Credentials are stored only in browser `localStorage`, and requests go directly to R2. Use a bucket-scoped API token with minimum required permissions.

**Which browsers are supported?**  The latest Chrome, Edge, Firefox, and Safari. Internet Explorer is not supported.

**Where does image compression happen?**  Local mode runs through WebAssembly in the browser. Tinify mode sends images to the Tinify service.

**Why is my upload failing?**  Check credentials, bucket permissions, and CORS. Multipart uploads require `POST` / `PUT` / `DELETE` and an exposed `ETag` header. Files must not exceed 1 TiB.

## Feedback

- [GitHub Issues](https://github.com/vikiboss/r2-web/issues) — bugs and feature requests
- [QQ Group](https://qm.qq.com/q/e47kAlbdsc) — Group ID: 1091212613

## License

MIT License

[ruanyifeng-weekly]: https://www.ruanyifeng.com/blog/2026/03/weekly-issue-387.html
[hellogithub-123]: https://hellogithub.com/periodical/volume/123
[vercel-deploy]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvikiboss%2Fr2-web&project-name=r2-web&repository-name=r2-web
[netlify-deploy]: https://app.netlify.com/start/deploy?repository=https%3A%2F%2Fgithub.com%2Fvikiboss%2Fr2-web&integrationName=r2-web&integrationSlug=r2-web
[cloudflare-deploy]: https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fvikiboss%2Fr2-web
