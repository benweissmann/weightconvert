import { defineConfig } from 'vite'
import path from 'path'
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const dataDir    = path.join(__dirname, 'data')
const modelDir   = path.join(__dirname, 'finetune', 'mlc-model')
const distData   = path.join(__dirname, 'dist', 'data')
const distModel  = path.join(__dirname, 'dist', 'model')

function serveDir(localDir, urlPrefix) {
  return (req, res, next) => {
    const file = path.join(localDir, req.url.split('?')[0])
    if (!file.startsWith(localDir)) return next()

    // Check the file exists and is a regular file — never fall through to Vite
    // for paths under this prefix, since Vite's SPA catch-all returns index.html
    // which web-llm then tries to JSON.parse, causing a confusing error.
    let isFile = false
    try { isFile = statSync(file).isFile() } catch {}
    if (!isFile) {
      res.statusCode = 404
      res.end('Not found')
      return
    }

    try {
      const ext = path.extname(file)
      const mime = ext === '.json' ? 'application/json'
                 : ext === '.wasm' ? 'application/wasm'
                 : 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      res.setHeader('Cache-Control', 'no-store')
      res.end(readFileSync(file))
    } catch {
      res.statusCode = 500
      res.end('Read error')
    }
  }
}

export default defineConfig({
  root: 'src',
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'static-assets',

      configureServer(server) {
        // Serve ../data/ at /data/
        server.middlewares.use('/data', serveDir(dataDir, '/data'))
        // Serve finetune/mlc-model/ at /model/ and /model/resolve/main/
        // (web-llm appends "resolve/main/" to non-HF URLs via cleanModelUrl)
        server.middlewares.use('/model', (req, res, next) => {
          req.url = req.url.replace(/^\/resolve\/main/, '')
          serveDir(modelDir, '/model')(req, res, next)
        })
      },

      closeBundle() {
        // Copy data files to dist/data/ unless hosting on S3
        if (!process.env.VITE_DATA_BASE_URL) {
          mkdirSync(distData, { recursive: true })
          for (const f of readdirSync(dataDir).filter(f => f.endsWith('.json'))) {
            copyFileSync(path.join(dataDir, f), path.join(distData, f))
          }
          console.log(`Copied ${readdirSync(distData).length} data files → dist/data/`)
        }

        // Copy model files to dist/model/ unless hosting on S3
        if (!process.env.VITE_MODEL_BASE_URL && existsSync(modelDir)) {
          mkdirSync(distModel, { recursive: true })
          for (const f of readdirSync(modelDir)) {
            copyFileSync(path.join(modelDir, f), path.join(distModel, f))
          }
          console.log(`Copied ${readdirSync(distModel).length} model files → dist/model/`)
        }
      },
    },
  ],
})
