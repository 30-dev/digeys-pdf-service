const express = require('express')
const puppeteer = require('puppeteer')

const app = express()
app.use(express.json())

const PORT     = process.env.PORT     || 3001
const API_KEY  = process.env.PDF_SERVICE_KEY

// Singleton del browser — se lanza una vez y se reutiliza entre requests
let browser = null

async function getBrowser() {
  if (browser && browser.connected) return browser
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // Railway: /dev/shm es pequeño
      '--disable-gpu',
      '--no-zygote',
    ],
  })
  browser.on('disconnected', () => { browser = null })
  return browser
}

// ── Middleware de autenticación
app.use((req, res, next) => {
  if (!API_KEY) return next()  // sin key configurada, modo dev abierto
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ── Health check (Railway lo usa para saber si el servicio está vivo)
app.get('/health', (_req, res) => {
  res.json({ ok: true, browser: !!browser })
})

// ── Endpoint principal: recibe URL → devuelve PDF
app.post('/pdf', async (req, res) => {
  const { url } = req.body

  if (!url) {
    return res.status(400).json({ error: 'Missing url in body' })
  }

  let page = null
  try {
    const b = await getBrowser()
    page = await b.newPage()

    // Viewport letter size a 96 dpi
    await page.setViewport({ width: 816, height: 1056 })

    // Bloquear recursos innecesarios para ir más rápido
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const type = req.resourceType()
      if (['image', 'media', 'font'].includes(type)) {
        // Permitir fuentes (Crimson Pro, DM Sans) y logo SVG
        req.continue()
      } else {
        req.continue()
      }
    })

    await page.goto(url, {
      waitUntil: 'networkidle0',  // espera a que carguen las fuentes de Google
      timeout: 60_000,
    })

    // Esperar a que React haya montado y el componente esté listo
    await page.waitForSelector('[data-ready="true"]', { timeout: 30_000 })

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
    })
    res.send(pdf)

  } catch (err) {
    console.error('PDF generation error:', err)
    res.status(500).json({ error: err.message })
  } finally {
    if (page) await page.close().catch(() => {})
  }
})

// ── Iniciar servidor
app.listen(PORT, async () => {
  console.log(`PDF Service listening on :${PORT}`)
  // Pre-calentar el browser al arrancar
  try {
    await getBrowser()
    console.log('Browser ready')
  } catch (e) {
    console.error('Browser failed to launch:', e.message)
  }
})
