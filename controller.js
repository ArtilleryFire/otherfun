// load env
require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/* discord config */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CMD_CHANNEL = "1443873014058844271"; // command channel id

/* bot config: these are logical bot names used in commands */
const BOT_CONFIG = {
  code: {
    logChannel: "1442086293029916693",
    logFile: path.join(__dirname, "logs", "code.log"),
    ipcFile: path.join(__dirname, "ipc", "code.json"),
    pidFile: path.join(__dirname, "ipc", "code.pid"),
    lastSize: 0
  },
  rey: {
    logChannel: "1444306259787645120",
    logFile: path.join(__dirname, "logs", "rey.log"),
    ipcFile: path.join(__dirname, "ipc", "rey.json"),
    pidFile: path.join(__dirname, "ipc", "rey.pid"),
    lastSize: 0
  },
  mate: {
    logChannel: "1444044532336431337",
    logFile: path.join(__dirname, "logs", "mate.log"),
    ipcFile: path.join(__dirname, "ipc", "mate.json"),
    pidFile: path.join(__dirname, "ipc", "mate.pid"),
    lastSize: 0
  },
  tega: {
    logChannel: "1444362238965317663",
    logFile: path.join(__dirname, "logs", "tega.log"),
    ipcFile: path.join(__dirname, "ipc", "tega.json"),
    pidFile: path.join(__dirname, "ipc", "tega.pid"),
    lastSize: 0
  }
};

/* batch config: which bots are in which batch */
const BATCH_CONFIG = {
  batch1: {
    script: path.join(__dirname, "bots", "batch1.js"),
    bots: ["harrisonx", "mate"]
  },
  batch2: {
    script: path.join(__dirname, "bots", "batch2.js"),
    bots: ["tega", "fia"]
  }
};

/* track which bots we think are running, and PIDs for batches */
const activeBots = {};
let ipcIdCounter = Date.now();
const batchPids = {
  batch1: null,
  batch2: null
};

/* discord client */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

/* helper: check if pid is alive (windows) */
function isPidAlive(pid) {
  try {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
    return out.stdout && out.stdout.includes(pid.toString());
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

/* restore bots that were running before controller restart */
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

/* best-effort: derive batch PID from its bots' pid files */
function deriveBatchPid(batchName) {
  const batchCfg = BATCH_CONFIG[batchName];
  if (!batchCfg) return null;

  let pid = null;
  for (const botName of batchCfg.bots) {
    const botPid = getBotPid(botName);
    if (!botPid) return null;
    if (pid === null) pid = botPid;
    else if (pid !== botPid) return null; // mismatch
  }
  return pid;
}

/* message handler */
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channel.id !== CMD_CHANNEL) return;

    const parts = msg.content.trim().split(" ");
    const cmd = (parts.shift() || "").toLowerCase();

    /* ;bot <BotName|batch1|batch2|all> */
    if (cmd === ";bot") {
      const argRaw = parts[0];
      const arg = (argRaw || "").toLowerCase();
      if (!arg) return msg.reply("Usage: ;bot <BotName|batch1|batch2|all>");

      // batches
      if (arg === "batch1" || arg === "batch2") {
        const batchName = arg;
        const batchCfg = BATCH_CONFIG[batchName];
        if (!batchCfg) return msg.reply("Unknown batch.");

        if (batchPids[batchName] && isPidAlive(batchPids[batchName])) {
          return msg.reply(`${batchName} already running (pid=${batchPids[batchName]}).`);
        }

        if (!fs.existsSync(batchCfg.script)) {
          return msg.reply(`Batch script not found: ${batchCfg.script}`);
        }

        // clear logs for bots in this batch
        for (const name of batchCfg.bots) {
          const cfg = BOT_CONFIG[name];
          if (!cfg) continue;
          try {
            fs.writeFileSync(cfg.logFile, "");
            cfg.lastSize = 0;
            console.log(`Cleared log for ${name}: ${cfg.logFile}`);
          } catch (err) {
            console.error(`Failed to clear log for ${name}:`, err.message);
          }
        }

        const child = spawn("node", [batchCfg.script], {
          detached: true,
          stdio: "ignore"
        });
        batchPids[batchName] = child.pid;
        child.unref();

        for (const name of batchCfg.bots) {
          activeBots[name] = true;
        }

        return msg.reply(`Started ${batchName} (pid=${batchPids[batchName]}).`);
      }

      if (arg === "all") {
        // start both batches
        let msgText = "";
        for (const bName of Object.keys(BATCH_CONFIG)) {
          const bCfg = BATCH_CONFIG[bName];
          if (!fs.existsSync(bCfg.script)) {
            msgText += `Batch script not found: ${bCfg.script}\n`;
            continue;
          }
          if (batchPids[bName] && isPidAlive(batchPids[bName])) {
            msgText += `${bName} already running (pid=${batchPids[bName]}).\n`;
            continue;
          }

          const child = spawn("node", [bCfg.script], {
            detached: true,
            stdio: "ignore"
          });
          batchPids[bName] = child.pid;
          child.unref();

          for (const name of bCfg.bots) activeBots[name] = true;
          msgText += `Started ${bName} (pid=${batchPids[bName]}).\n`;
        }
        return msg.reply("```\n" + msgText + "```");
      }

      // start single-bot script (legacy mode, optional)
      const botName = arg;
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");
      if (activeBots[botName]) return msg.reply("Bot is already marked as running.");

      const cfg = BOT_CONFIG[botName];
      const botPath = path.join(__dirname, "bots", botName + ".js");
      if (!fs.existsSync(botPath)) return msg.reply("Bot script not found.");

      try {
        fs.writeFileSync(cfg.logFile, "");
        cfg.lastSize = 0;
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

    /* ;stop <BotName|batch1|batch2|all> */
    else if (cmd === ";stop") {
      const argRaw = parts[0];
      const arg = (argRaw || "").toLowerCase();
      if (!arg) return msg.reply("Usage: ;stop <BotName|batch1|batch2|all>");

      if (arg === "batch1" || arg === "batch2") {
        const batchName = arg;
        let pid = batchPids[batchName];
        if (!pid) pid = deriveBatchPid(batchName);
        if (pid && isPidAlive(pid)) {
          spawn("taskkill", ["/PID", pid.toString(), "/T", "/F"]);
          msg.reply(`Sent kill to ${batchName} (pid=${pid}).`);
        } else {
          msg.reply(`No alive PID found for ${batchName}.`);
        }
        batchPids[batchName] = null;
        const bCfg = BATCH_CONFIG[batchName];
        if (bCfg) {
          for (const name of bCfg.bots) delete activeBots[name];
        }
        return;
      }

      if (arg === "all") {
        let text = "";
        for (const bName of Object.keys(BATCH_CONFIG)) {
          let pid = batchPids[bName];
          if (!pid) pid = deriveBatchPid(bName);
          if (pid && isPidAlive(pid)) {
            spawn("taskkill", ["/PID", pid.toString(), "/T", "/F"]);
            text += `Sent kill to ${bName} (pid=${pid}).\n`;
          } else {
            text += `No alive PID for ${bName}.\n`;
          }
          batchPids[bName] = null;
          const bCfg = BATCH_CONFIG[bName];
          if (bCfg) {
            for (const name of bCfg.bots) delete activeBots[name];
          }
        }
        return msg.reply("```\n" + text + "```");
      }

      // stop specific bot
      const botName = arg;
      if (!BOT_CONFIG[botName]) return msg.reply("Unknown bot name.");

      const pid = getBotPid(botName);
      if (pid && isPidAlive(pid)) {
        spawn("taskkill", ["/PID", pid.toString(), "/T", "/F"]);
        msg.reply(`Sent kill to ${botName} (pid=${pid}).`);
      } else {
        msg.reply(`No alive PID for ${botName}.`);
      }
      delete activeBots[botName];
    }

    /* ;chat <BotName|batch1|batch2|all> <message> */
    else if (cmd === ";chat") {
      const targetRaw = parts.shift();
      const text = parts.join(" ");
      const target = (targetRaw || "").toLowerCase();
      if (!target || !text) {
        return msg.reply("Usage: ;chat <BotName|batch1|batch2|all> <message>");
      }

      if (target === "all") {
        for (const name in BOT_CONFIG) {
          writeIPC(name, { type: "chat", message: text });
        }
        return msg.reply(`Sent chat to all bots: ${text}`);
      }

      if (target === "batch1" || target === "batch2") {
        const bCfg = BATCH_CONFIG[target];
        if (!bCfg) return msg.reply("Unknown batch.");
        for (const name of bCfg.bots) {
          writeIPC(name, { type: "chat", message: text });
        }
        return msg.reply(`Sent chat to ${target}: ${text}`);
      }

      if (!BOT_CONFIG[target]) return msg.reply("Unknown bot name.");

      writeIPC(target, { type: "chat", message: text });
      msg.reply(`Sent chat to ${target}: ${text}`);
    }

    /* ;shop <BotName|batch1|batch2|all> */
    else if (cmd === ";shop") {
      const targetRaw = parts[0];
      const target = (targetRaw || "").toLowerCase();
      if (!target) return msg.reply("Usage: ;shop <BotName|batch1|batch2|all>");

      if (target === "all") {
        for (const name in BOT_CONFIG) {
          writeIPC(name, { type: "startLoop" });
        }
        return msg.reply("StartLoop sent to all bots.");
      }

      if (target === "batch1" || target === "batch2") {
        const bCfg = BATCH_CONFIG[target];
        if (!bCfg) return msg.reply("Unknown batch.");
        for (const name of bCfg.bots) {
          writeIPC(name, { type: "startLoop" });
        }
        return msg.reply(`StartLoop sent to ${target}.`);
      }

      if (!BOT_CONFIG[target]) return msg.reply("Unknown bot name.");

      writeIPC(target, { type: "startLoop" });
      msg.reply(`StartLoop sent to ${target}.`);
    }

    /* ;stopshop <BotName|batch1|batch2|all> */
    else if (cmd === ";stopshop") {
      const targetRaw = parts[0];
      const target = (targetRaw || "").toLowerCase();
      if (!target) return msg.reply("Usage: ;stopshop <BotName|batch1|batch2|all>");

      if (target === "all") {
        for (const name in BOT_CONFIG) {
          writeIPC(name, { type: "stopLoop" });
        }
        return msg.reply("StopLoop sent to all bots.");
      }

      if (target === "batch1" || target === "batch2") {
        const bCfg = BATCH_CONFIG[target];
        if (!bCfg) return msg.reply("Unknown batch.");
        for (const name of bCfg.bots) {
          writeIPC(name, { type: "stopLoop" });
        }
        return msg.reply(`StopLoop sent to ${target}.`);
      }

      if (!BOT_CONFIG[target]) return msg.reply("Unknown bot name.");

      writeIPC(target, { type: "stopLoop" });
      msg.reply(`StopLoop sent to ${target}.`);
    }

    /* ;status */
    else if (cmd === ";status") {
      let text = "";

      text += "Batch PIDs:\n";
      for (const bName of Object.keys(BATCH_CONFIG)) {
        const pid = batchPids[bName] || deriveBatchPid(bName) || "none";
        text += `- ${bName}: pid=${pid}\n`;
      }
      text += "\nBots this controller believes are running:\n";
      const names = Object.keys(BOT_CONFIG);
      if (!names.length) text += "none\n";
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
