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
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
    ],
  })
  browser.on('disconnected', () => { browser = null })
  return browser
}

// ── Health check — ANTES del middleware de auth para que Railway lo alcance
app.get('/health', (_req, res) => {
  res.json({ ok: true, browser: !!browser })
})

// ── Middleware de autenticación (aplica a /pdf y demás rutas)
app.use((req, res, next) => {
  if (!API_KEY) return next()  // sin key configurada, modo dev abierto
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
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
      waitUntil: 'networkidle2',  // permite hasta 2 conexiones activas (fuentes)
      timeout: 60_000,
    })

    // Pausa adicional para que React hidrate completamente
    await new Promise(r => setTimeout(r, 2000))

    const pdfRaw = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })

    // puppeteer v24+ devuelve Uint8Array — convertir a Buffer para Express
    const pdf = Buffer.from(pdfRaw)

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
app.listen(PORT, () => {
  console.log(`PDF Service listening on :${PORT}`)
  // Browser se inicia en el primer request — no pre-calentar al arrancar
})
