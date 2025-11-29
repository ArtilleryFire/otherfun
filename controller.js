// load env
require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { spawn } = require("child_process");
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
    pidFile: path.join(__dirname, "ipc", "harrisonx.pid"), // still written by bot, but controller no longer uses it for kill
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

let ipcIdCounter = Date.now();

/* discord client */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* ---------- PM2 helpers ---------- */

function runPm2(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pm2", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `pm2 ${args.join(" ")} exited with code ${code}`));
    });
  });
}

/* ---------- startup ---------- */

client.once("ready", () => {
  console.log(`Controller online as: ${client.user.tag}`);
  startLogTailer();
});

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

/* ---------- DISCORD COMMANDS ---------- */

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channel.id !== CMD_CHANNEL) return;

    const parts = msg.content.trim().split(" ");
    const cmd = (parts.shift() || "").toLowerCase();

    // ;bot <BotName>  -> start via PM2
    if (cmd === ";bot") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;bot <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      const cfg = BOT_CONFIG[botName];
      const botPath = path.join(__dirname, "bots", botName + ".js");
      if (!fs.existsSync(botPath)) return msg.reply("Bot script not found at: " + botPath);

      // clear log file on each start
      try {
        fs.writeFileSync(cfg.logFile, "");
        cfg.lastSize = 0;
        console.log(`Cleared log for ${botName}: ${cfg.logFile}`);
      } catch (err) {
        console.error(`Failed to clear log for ${botName}:`, err.message);
      }

      try {
        // pm2 start bots/harrisonx.js --name harrisonx
        await runPm2(["start", botPath, "--name", botName]);
        await msg.reply(`Started bot '${botName}' via PM2.`);
      } catch (err) {
        // if already running, PM2 will complain – just forward message
        console.error("pm2 start error:", err.message);
        await msg.reply(`Failed to start bot '${botName}':\n\`\`\`\n${err.message}\n\`\`\``);
      }
    }

    // ;stop <BotName> -> stop via PM2
    else if (cmd === ";stop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;stop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      try {
        await runPm2(["stop", botName]);
        await runPm2(["delete", botName]); // optional: remove from PM2 list
        await msg.reply(`Stopped bot '${botName}' via PM2.`);
      } catch (err) {
        console.error("pm2 stop error:", err.message);
        await msg.reply(`Failed to stop bot '${botName}':\n\`\`\`\n${err.message}\n\`\`\``);
      }
    }

    // ;chat <BotName> <message>
    else if (cmd === ";chat") {
      const botName = parts.shift();
      const text = parts.join(" ");
      if (!botName || !text) return msg.reply("Usage: ;chat <BotName> <message>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "chat", message: text });
      msg.reply(`Sent chat to ${botName}: ${text}`);
    }

    // ;shop <BotName> -> send startLoop IPC
    else if (cmd === ";shop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;shop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "startLoop" });
      msg.reply(`StartLoop sent to ${botName}.`);
    }

    // ;stopshop <BotName> -> send stopLoop IPC
    else if (cmd === ";stopshop") {
      const botName = parts[0];
      if (!botName) return msg.reply("Usage: ;stopshop <BotName>");
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      writeIPC(botName, { type: "stopLoop" });
      msg.reply(`StopLoop sent to ${botName}.`);
    }

    // ;status -> query PM2
    else if (cmd === ";status") {
      try {
        const { stdout } = await runPm2(["jlist"]);
        let list;
        try {
          list = JSON.parse(stdout);
        } catch (e) {
          return msg.reply("Failed to parse PM2 process list.");
        }

        const names = Object.keys(BOT_CONFIG);
        let text = "Bot status (from PM2):\n\n";

        for (const name of names) {
          const proc = list.find(p => p.name === name);
          if (!proc) {
            text += `- ${name}: not in PM2 list\n`;
          } else {
            const pm2State = proc.pm2_env?.status || "unknown";
            const pid = proc.pid || proc.pm2_env?.pm_id;
            text += `- ${name}: status=${pm2State}, pid=${pid}\n`;
          }
        }

        await msg.reply("```\n" + text + "```");
      } catch (err) {
        console.error("pm2 jlist error:", err.message);
        await msg.reply(`Failed to read PM2 status:\n\`\`\`\n${err.message}\n\`\`\``);
      }
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
