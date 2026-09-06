import { extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import express, { type Response } from 'express'

// npm archives preserve file timestamps: size + mtime is not a version validator.
const frontendFileOptions = { etag: false, lastModified: false, cacheControl: false }

export async function sendFrontendEntry(response: Response, filePath: string) {
  const contents = await readFile(filePath)
  // Express sendFile overrides its etag option with the app setting. End the
  // small HTML response directly so existing API/file cache settings stay intact.
  response.setHeader('Cache-Control', 'no-store')
  response.type('html').end(contents)
}

export function createFrontendAssetsMiddleware(directory: string) {
  const router = express.Router()
  router.use(express.static(directory, {
    ...frontendFileOptions,
    setHeaders(response, filePath) {
      const hashedAsset = filePath.replaceAll('\\', '/').includes('/assets/')
        && /-[\w-]{8,}\.[\w]+$/.test(filePath)
      response.setHeader('Cache-Control', hashedAsset ? 'public, max-age=31536000, immutable' : 'no-store')
    },
  }))
  router.use((request, response, next) => {
    const isResource = request.path.startsWith('/assets/') || request.path.startsWith('/icons/') || request.path.startsWith('/codex-api/')
      || Boolean(extname(request.path))
      || ['script', 'style', 'image', 'font', 'manifest'].includes(String(request.headers['sec-fetch-dest']))
    if (!['GET', 'HEAD'].includes(request.method) || isResource) {
      response.setHeader('Cache-Control', 'no-store')
      response.status(404).type('text/plain').send('Not found')
      return
    }
    response.setHeader('Cache-Control', 'no-store')
    next()
  })
  return router
}
