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
client.once("clientReady", () => {
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
        await channel.send("```\n" + msg + "```");
      }
      msg = `[${botName}] ${line}\n`;
    } else {
      msg = next;
    }
  }
  if (msg.length) {
    await channel.send("```\n" + msg + "```");
  }
}

/* write IPC command */
function writeIPC(botName, payload) {
  const cfg = BOT_CONFIG[botName];
  if (!cfg) return;

  const data = { id: ++ipcIdCounter, ...payload };
  fs.writeFileSync(cfg.ipcFile, JSON.stringify(data));
}

/* get PID from pidFile */
function getBotPid(botName) {
  const cfg = BOT_CONFIG[botName];
  if (!cfg) return null;
  if (!fs.existsSync(cfg.pidFile)) return null;

  try {
    const pidStr = fs.readFileSync(cfg.pidFile, "utf8").trim();
    const pid = parseInt(pidStr, 10);
    if (!pid || Number.isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

/* message handler */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channel.id !== CMD_CHANNEL) return;

    const parts = msg.content.trim().split(" ");
    const cmd = (parts.shift() || "").toLowerCase();

    if (cmd === ";bot") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;bot <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");
      if (activeBots[botName]) return msg.reply("Bot is already marked as running.");

      const cfg = BOT_CONFIG[botName];

      const botPath = path.join(__dirname, "bots", botName + ".js");
      if (!fs.existsSync(botPath)) return msg.reply("Bot script not found.");

      // clear log file for this bot on each start
      try {
        fs.writeFileSync(cfg.logFile, "");   // truncate to 0 bytes
        cfg.lastSize = 0;                    // reset tail pointer
        console.log(`Cleared log for ${botName}: ${cfg.logFile}`);
      } catch (err) {
        console.error(`Failed to clear log for ${botName}:`, err.message);
      }

      const child = spawn("node", [botPath], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();

      activeBots[botName] = true;

      msg.reply(`Started bot '${botName}'.`);
    }

    else if (cmd === ";stop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;stop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      const pid = getBotPid(botName);
      if (pid && isPidAlive(pid)) {
        // Fixed: Use Linux kill command instead of Windows taskkill
        spawn("kill", ["-9", pid.toString()]);
        msg.reply(`Sent kill to ${botName} (pid=${pid}).`);
      } else {
        msg.reply(`No alive PID for ${botName}, trying generic kill.`);
        // Optional: Use pkill for node processes, but be careful
        spawn("pkill", ["-f", "node.*" + botName]);
      }

      delete activeBots[botName];
    }

    else if (cmd === ";chat") {
      const botName = parts.shift();
      const text = parts.join(" ");
      if (!botName || !text) return msg.reply("Usage: ;chat <BotName> <message>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "chat", message: text });
      msg.reply(`Sent chat to ${botName}: ${text}`);
    }

    else if (cmd === ";shop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;shop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "startLoop" });
      msg.reply(`StartLoop sent to ${botName}.`);
    }

    else if (cmd === ";stopshop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;stopshop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "stopLoop" });
      msg.reply(`StopLoop sent to ${botName}.`);
    }

    else if (cmd === ";status") {
      let text = "Bots this controller believes are running:\n";
      const names = Object.keys(BOT_CONFIG);
      if (!names.length) text += "none";
      for (const name of names) {
        const pid = getBotPid(name);
        const alive = pid && isPidAlive(pid);
        const flagged = !!activeBots[name];
        text += `- ${name}: pid=${pid || "none"}, alive=${alive}, activeFlag=${flagged}\n`;
      }
      msg.reply("```\n" + text + "```");
    }

  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

client.on("error", (err) => {
  console.error("Discord client error:", err);
});

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

client.login(DISCORD_TOKEN);

