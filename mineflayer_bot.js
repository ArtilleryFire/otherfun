// mineflayer_bot.js
const mineflayer = require('mineflayer')
const readline = require('readline')

const RETRY_DELAY_MS = 15000

let bot
let reconnectTimeout = null
let lastOptions = null // simpan input biar dipakai lagi saat reconnect

function log(...args) {
  const time = new Date().toISOString().split('T')[1].replace('Z', '')
  console.log(`[${time}]`, ...args)
}

function createBot(options) {
  lastOptions = options

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  log('Creating bot...')

  bot = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version || false, // auto detect kalau kosong
  })

  bot.once('spawn', () => {
    log('Bot spawned on the server.')

    // Auto /login kalau password diisi
    if (options.loginPassword) {
      log('Sending /login command...')
      bot.chat(`/login ${options.loginPassword}`)
    }

    // Kalau mau auto /register atau /server survival, tinggal tambah di sini
    // bot.chat('/register password password')
    // bot.chat('/server survival')
  })

  bot.on('message', (jsonMsg) => {
    try {
      const msg = jsonMsg.toAnsi ? jsonMsg.toAnsi() : jsonMsg.toString()
      log('[CHAT]', msg)
    } catch (err) {
      log('[CHAT RAW]', JSON.stringify(jsonMsg))
    }
  })

  bot.on('error', (err) => {
    log('Bot error:', err && err.stack ? err.stack : err)
    if (err.code === 'ECONNRESET') {
      log('Connection reset by server (ECONNRESET).')
    }
  })

  bot.on('end', () => {
    log('Bot disconnected from server. Scheduling reconnect...')
    if (!reconnectTimeout && lastOptions) {
      reconnectTimeout = setTimeout(() => {
        log(`Reconnecting to ${lastOptions.host}:${lastOptions.port} as ${lastOptions.username}...`)
        createBot(lastOptions)
      }, RETRY_DELAY_MS)
    }
  })
}

// ==== BAGIAN INPUT INTERAKTIF ====

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question, defaultValue = '') {
  return new Promise((resolve) => {
    const q = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `
    rl.question(q, (answer) => {
      resolve(answer.trim() || defaultValue)
    })
  })
}

async function main() {
  try {
    const defaultHost = process.env.MC_HOST || 'play.craftnesia.my.id'
    const defaultPort = process.env.MC_PORT || '25565'
    const defaultUsername = process.env.MC_USERNAME || 'NaftarDD'
    const defaultVersion = process.env.MC_VERSION || '' // kosong = auto detect

    const host = await ask('Host server', defaultHost)
    const portStr = await ask('Port', defaultPort)
    const username = await ask('Username (nickname bot)', defaultUsername)
    const loginPassword = await ask('Password untuk /login (kosongkan kalau tidak perlu)', '')
    const version = await ask('Versi Minecraft server (kosongkan untuk auto detect)', defaultVersion)

    rl.close()

    const options = {
      host,
      port: Number(portStr) || 25565,
      username,
      loginPassword: loginPassword || null,
      version: version || false,
    }

    log('Starting bot with options:', options)
    createBot(options)
  } catch (err) {
    rl.close()
    console.error('Error saat input:', err)
    process.exit(1)
  }
}

process.on('uncaughtException', (err) => {
  log('Uncaught exception:', err && err.stack ? err.stack : err)
})

process.on('unhandledRejection', (reason) => {
  log('Unhandled rejection:', reason)
})

main()
