// bot.js
const mineflayer = require('mineflayer')

const HOST = process.env.MC_HOST || 'alwination.id'
const PORT = Number(process.env.MC_PORT || 25565)
const USERNAME = process.env.MC_USERNAME || 'NaftarDD'
// Ganti sesuai versi server kalau tahu, misal '1.21', '1.20.4', dll
const VERSION = process.env.MC_VERSION || '1.20.4'

// delay reconnect biar nggak kebaca flood / bot attack
const RETRY_DELAY_MS = Number(process.env.MC_RETRY_DELAY || 15000)

let bot
let reconnectTimeout = null

function log(...args) {
  const time = new Date().toISOString().split('T')[1].replace('Z', '')
  console.log(`[${time}]`, ...args)
}

function createBot() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  log('Creating bot...')

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    // kalau pakai akun resmi Microsoft:
    // auth: 'microsoft',
    // password: '...'
  })

  // EVENT: berhasil join dunia
  bot.once('spawn', () => {
    log('Bot spawned on the server.')

    // Contoh: kirim command otomatis setelah join
    // (Sesuaikan dengan kebutuhan server kamu)
    // bot.chat('/register password password')
    // bot.chat('/login password')
    // bot.chat('/server survival')
  })

  // EVENT: chat (kalau ada error parsing, minimal kita lihat raw-nya)
  bot.on('message', (jsonMsg, position) => {
    try {
      // beberapa versi pakai .toAnsi(), beberapa .toString()
      const msg = jsonMsg.toAnsi ? jsonMsg.toAnsi() : jsonMsg.toString()
      log('[CHAT]', msg)
    } catch (err) {
      log('[CHAT RAW]', JSON.stringify(jsonMsg, null, 2))
    }
  })

  // EVENT: error dari mineflayer / koneksi
  bot.on('error', (err) => {
    log('Bot error:', err && err.stack ? err.stack : err)

    // Banyak ECONNRESET dari server → biarkan handler 'end' yang urus reconnect
    if (err.code === 'ECONNRESET') {
      log('Connection reset by server (ECONNRESET).')
    }
  })

  // EVENT: koneksi terputus
  bot.on('end', () => {
    log('Bot disconnected from server. Scheduling reconnect...')

    if (!reconnectTimeout) {
      reconnectTimeout = setTimeout(() => {
        log(`Reconnecting to ${HOST}:${PORT} as ${USERNAME}...`)
        createBot()
      }, RETRY_DELAY_MS)
    }
  })
}

// Handler global biar Node.js nggak langsung mati tanpa log
process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err && err.stack ? err.stack : err)
})

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection:', reason)
})

// Start pertama kali
createBot()
