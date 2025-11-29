// load env
require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/* discord config */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CMD_CHANNEL = "1443873014058844271"; // command channel id

/* bot config */
const BOT_CONFIG = {
  harrisonx: {
    logChannel: "1442086293029916693",
    logFile: path.join(__dirname, "logs", "harrisonx.log"),
    ipcFile: path.join(__dirname, "ipc", "harrisonx.json"),
    pidFile: path.join(__dirname, "ipc", "harrisonx.pid"),
    lastSize: 0
  },
  rea: {
    logChannel: "1444044532336431337",
    logFile: path.join(__dirname, "logs", "rea.log"),
    ipcFile: path.join(__dirname, "ipc", "rea.json"),
    pidFile: path.join(__dirname, "ipc", "rea.pid"),
    lastSize: 0
  }
};

const activeBots = {};
let ipcIdCounter = Date.now();

/* discord client */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* helper: check if pid is alive (linux) */
function isPidAlive(pid) {
  try {
    // Use /proc filesystem to check if process exists (Linux-specific)
    return fs.existsSync(`/proc/${pid}`);
  } catch (err) {
    console.error("isPidAlive error:", err.message);
    return false;
  }
}

/* on ready */
client.once("ready", () => {  // Fixed: Was "clientReady", should be "ready"
  console.log(`Controller online as: ${client.user.tag}`);

  restoreRunningBots();
  startLogTailer();
});

/* restore bots that were already running before controller restart */
function restoreRunningBots() {
  for (const name in BOT_CONFIG) {
    const cfg = BOT_CONFIG[name];
    if (!fs.existsSync(cfg.pidFile)) continue;

    const pidStr = fs.readFileSync(cfg.pidFile, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (!pid || Number.isNaN(pid)) {
      try { fs.unlinkSync(cfg.pidFile); } catch {}
      continue;
    }

    if (isPidAlive(pid)) {
      activeBots[name] = true;
      console.log(`Restored running bot: ${name} (pid=${pid})`);
    } else {
      try { fs.unlinkSync(cfg.pidFile); } catch {}
    }
  }
}

/* tail logs and send to discord */
function startLogTailer() {
  setInterval(() => {
    for (const botName in BOT_CONFIG) {
      const cfg = BOT_CONFIG[botName];
      if (!fs.existsSync(cfg.logFile)) continue;

      const stats = fs.statSync(cfg.logFile);
      if (stats.size <= cfg.lastSize) continue;

      const fd = fs.openSync(cfg.logFile, "r");
      const buffer = Buffer.alloc(stats.size - cfg.lastSize);
      fs.readSync(fd, buffer, 0, buffer.length, cfg.lastSize);
      fs.closeSync(fd);

      const newLines = buffer
        .toString()
        .split("\n")
        .filter(l => l.trim() !== "");

      cfg.lastSize = stats.size;

      sendLogLines(botName, newLines).catch(err =>
        console.error("sendLogLines error:", err.message)
      );
    }
  }, 3000);
}

/* send logs with 4000-char safe split */
async function sendLogLines(botName, lines) {
  const cfg = BOT_CONFIG[botName];
  const channel = client.channels.cache.get(cfg.logChannel);
  if (!channel || !lines.length) return;

  let msg = "";
  for (const line of lines) {
    const next = msg + `[${botName}] ${line}\n`;
    if (next.length > 3900) {
      if (msg.length) {
        await channel.send("
