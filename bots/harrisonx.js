const mineflayer = require("mineflayer");
const mcDataLoader = require("minecraft-data");
const fs = require("fs");
const path = require("path");

/* config */
const CONFIG = {
  mc: {
    host: "alwination.id",
    port: 25565,
    version: "1.21.1",
    username: "HarrisonX",
    loginPassword: "123rty",
    queueCommand: "/joinq survival"
  },
  loop: { targetBlocks: 18 * 64 },
  gui: {
    shopMain: "Global Market",
    boneCategorySlot: 34,
    boneCategoryTitle: "Miscellanous",
    boneItemSlot: 41,
    boneBuyTitle: "Buying Bone Meal",
    buyMoreSlot: 31,
    buy9StacksSlot: 8,
    sellTitle: "Sell GUI"
  }
};

/* paths */
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const IPC_DIR = path.join(ROOT, "ipc");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(IPC_DIR)) fs.mkdirSync(IPC_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "harrisonx.log");
const IPC_FILE = path.join(IPC_DIR, "harrisonx.json");
const PID_FILE = path.join(IPC_DIR, "harrisonx.pid");

try {
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch {}

process.on("exit", () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
});

/* state */
let bot = null;
let mcData = null;
let botReady = false;
let botDisconnected = false;
let lastIpcId = 0;
let lastPaywall = 0;
let isLoopRunning = false;
let stopRequested = false;
let lastActivity = Date.now();
const LOOP_TIMEOUT = 5 * 60 * 1000;

/* utils */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fast() { return sleep(300 + Math.random() * 200); }
function medium() { return sleep(700 + Math.random() * 300); }

// important=false -> console only, important=true -> console + file (Discord)
function log(msg, important = false) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  lastActivity = Date.now();
  if (important) {
    fs.appendFileSync(LOG_FILE, line + "\n");
  }
}

function countItems(name) {
  if (!bot || !bot.inventory) return 0;
  let t = 0;
  for (const s of bot.inventory.slots) if (s && s.name === name) t += s.count;
  return t;
}
function windowReady() {
  return bot.currentWindow && bot.currentWindow.slots;
}
function safeClose() {
  try { bot.closeWindow(); } catch {}
}
function getTitle(win) {
  if (!win || !win.title) return "";
  const t = win.title;
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && typeof t.text === "string") return t.text;
  try {
    if (t.value && t.value.translate && typeof t.value.translate.value === "string") {
      return t.value.translate.value;
    }
    if (t.value?.extra?.value?.value) {
      return t.value.extra.value.value.map(p => p.text?.value || "").join("");
    }
    if (t.value?.text?.value) return t.value.text.value;
  } catch (e) {}
  return "";
}

/* IPC */
async function ipcLoop() {
  while (true) {
    try {
      if (fs.existsSync(IPC_FILE)) {
        const raw = fs.readFileSync(IPC_FILE, "utf8");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.id && data.id !== lastIpcId) {
            lastIpcId = data.id;
            await handleIPC(data);
          }
        }
      }
    } catch (err) {
      log("IPC error: " + err.message, true);
    }
    await sleep(1000);
  }
}
async function handleIPC(data) {
  if (data.type === "chat") {
    if (bot) bot.chat(data.message);
    log("IPC chat: " + data.message);
  }
  if (data.type === "startLoop") {
    log("IPC startLoop", true);
    if (!isLoopRunning) {
      stopRequested = false;
      isLoopRunning = true;
      mainLoop();
    }
  }
  if (data.type === "stopLoop") {
    log("IPC stopLoop", true);
    stopRequested = true;
  }
}

/* heartbeat */
async function heartbeat() {
  while (true) {
    if (Date.now() - lastActivity > LOOP_TIMEOUT) {
      log("Loop timeout, restarting connection", true);
      safeClose();
      if (bot) bot.end();
    }
    await sleep(60000);
  }
}

/* bot create/reconnect */
function createBot() {
  log("Spawning bot...", true);
  botReady = false;
  botDisconnected = false;
  bot = mineflayer.createBot({
    host: CONFIG.mc.host,
    port: CONFIG.mc.port,
    username: CONFIG.mc.username,
    version: CONFIG.mc.version,
    auth: "offline",
    disableChatSigning: true
  });

  bot.once("spawn", () => {
    log("Bot spawned", true);
    mcData = mcDataLoader(bot.version);
    setTimeout(() => {
      bot.chat(`/login ${CONFIG.mc.loginPassword}`);
      log("Sent /login");
    }, 3000);
    setTimeout(() => {
      bot.chat(CONFIG.mc.queueCommand);
      log("Sent queue command");
    }, 6000);
    setTimeout(() => {
      if (bot.player) {
        botReady = true;
        log("BOT READY", true);
      }
    }, 10000);
  });

  bot.on("message", (json) => {
    const msg = json.toString().toLowerCase();
    if (msg.includes("not enough") || msg.includes("cannot") || msg.includes("you need")) {
      lastPaywall = Date.now();
      log("Paywall: " + msg, true);
    }
  });

bot.on("end", (reason) => {
  log(`Disconnected: ${reason || "Unknown reason"}. Full error: ${JSON.stringify(reason)}`, true);
  botDisconnected = true;
  botReady = false;
  isLoopRunning = false;
  setTimeout(createBot, 10000);  // Increase delay to 10s to avoid spam
});
}

/* clear cursor by placing into first empty slot in open window */
async function ensureCursorEmpty(win) {
  const cursor = bot.inventory.cursor;
  if (!cursor) return;
  const total = win.slots.length;
  let playerStart = total - 36;
  if (playerStart < 0) playerStart = 0;
  let emptySlot = null;
  for (let i = playerStart; i < total; i++) {
    if (!win.slots[i]) { emptySlot = i; break; }
  }
  if (emptySlot === null) {
    log("No empty slot to clear cursor");
    return;
  }
  log(`Clearing cursor into slot ${emptySlot}`);
  await bot.clickWindow(emptySlot, 0, 0);
  await sleep(150);
}

/* shop helpers */
async function openShopRoot() {
  safeClose();
  await sleep(300);
  bot.chat("/shop");
  await medium();
  if (!windowReady()) return false;
  const title = getTitle(bot.currentWindow);
  log("Shop GUI title: " + title);
  return title.includes(CONFIG.gui.shopMain);
}
async function clickBoneCategory() {
  bot.clickWindow(CONFIG.gui.boneCategorySlot, 0, 0);
  await medium();
  if (!windowReady()) return false;
  const title = getTitle(bot.currentWindow);
  log("Category GUI title: " + title);
  return title.includes(CONFIG.gui.boneCategoryTitle);
}
async function clickBoneItem() {
  bot.clickWindow(CONFIG.gui.boneItemSlot, 0, 0);
  await fast();
  if (!windowReady()) return false;
  const title = getTitle(bot.currentWindow);
  log("Buy GUI title: " + title);
  return title.includes(CONFIG.gui.boneBuyTitle);
}
async function clickBuyMoreAndStacks() {
  bot.clickWindow(CONFIG.gui.buyMoreSlot, 0, 0);
  await medium();
  if (!windowReady()) return false;
  let tries = 0;
  while (tries < 10 && (!bot.currentWindow.slots[0] || !bot.currentWindow.slots[8])) {
    await sleep(100);
    tries++;
  }
  const slot0 = bot.currentWindow.slots[0];
  const slot8 = bot.currentWindow.slots[8];
  log(`Stacks GUI slot0=${slot0?.name}, slot8=${slot8 ? "OK" : "null"}`);
  if (!slot0 || slot0.name !== "bone_meal") return false;
  if (!slot8) return false;
  bot.clickWindow(CONFIG.gui.buy9StacksSlot, 0, 0);
  await fast();
  await fast();
  return true;
}

/* buy bone meal */
async function buyBoneMeal() {
  const MAX = 2;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const before = countItems("bone_meal");
    log(`Buy attempt ${attempt + 1}/${MAX}. Before=${before}`);
    if (Date.now() - lastPaywall < 3000) {
      log("Paywall active, abort buy", true);
      return false;
    }
    if (!await openShopRoot()) continue;
    if (!await clickBoneCategory()) continue;
    if (!await clickBoneItem()) continue;
    if (!await clickBuyMoreAndStacks()) continue;
    const after = countItems("bone_meal");
    log("Bone meal after buy: " + after);
    if (after > before) {
      log("Buy success", true);
      return true;
    }
  }
  log("Buy failed", true);
  return false;
}

/* craft bone blocks one at a time to avoid excess bone meal turning into white dye */
async function craftBoneBlocksUntilLow() {
  if (!mcData) return;
  const boneMealName = "bone_meal";
  const boneBlockName = "bone_block";

  const boneBlockItem = mcData.itemsByName[boneBlockName];
  const boneMealItem = mcData.itemsByName[boneMealName];

  if (!boneBlockItem || !boneMealItem) {
    log("mcData missing bone_meal or bone_block", true);
    return;
  }

  const table = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!table || table.name !== "crafting_table") {
    log("No crafting table under bot", true);
    return;
  }

  const bm = countItems(boneMealName);
  if (bm < 9) {
    log("Bone meal < 9, skip crafting");
    return;
  }

  // Get recipes for bone_block using crafting table
  const recipes = bot.recipesFor(boneBlockItem.id, null, 1, table);
  if (!recipes || recipes.length === 0) {
    log("No bone_block recipes found", true);
    return;
  }

  // Use the first recipe (9 bone_meal -> 1 bone_block)
  const recipe = recipes[0];
  log("Using bone_block recipe (one at a time to avoid white dye)");

  const maxCrafts = Math.floor(bm / 9);
  const whiteDyeBefore = countItems("white_dye");

  // Craft one at a time to prevent excess
  for (let i = 0; i < maxCrafts; i++) {
    try {
      await bot.craft(recipe, 1, table);
      const bmAfter = countItems(boneMealName);
      const blocksAfter = countItems(boneBlockName);
      log(`Crafted 1 bone_block, bm=${bmAfter}, blocks=${blocksAfter}`);
    } catch (err) {
      log("Craft error: " + err.message, true);
      break;
    }
  }

  const whiteDyeAfter = countItems("white_dye");
  if (whiteDyeAfter > whiteDyeBefore) {
    log(`WARNING: White dye increased by ${whiteDyeAfter - whiteDyeBefore} during crafting!`, true);
  }
}

/* sell section - sell all bone blocks in batches */
async function sellSection() {
  log("Starting to sell all bone blocks");
  let totalSold = 0;

  while (true) {
    const currentBlocks = countItems("bone_block");
    if (currentBlocks === 0) {
      log(`Sold all bone blocks (total: ${totalSold})`, true);
      return;
    }

    log(`Selling batch: ${currentBlocks} bone blocks remaining`);
    safeClose();
    await sleep(300);
    bot.chat("/sellgui");
    await medium();
    if (!windowReady()) {
      log("Failed to open Sell GUI");
      return;
    }
    let win = bot.currentWindow;
    let title = getTitle(win);
    log("Sell GUI title: " + title);
    if (!title.includes(CONFIG.gui.sellTitle)) {
      log("Not in Sell GUI, retrying /sellgui");
      bot.chat("/sellgui");
      await medium();
      if (!windowReady()) return;
      win = bot.currentWindow;
      title = getTitle(win);
      log("Sell GUI title (retry): " + title);
    }
    if (!windowReady()) return;

    log("Placing bone blocks into Sell GUI");
    await ensureCursorEmpty(win);

    const total = win.slots.length;
    let playerStart = total - 36;
    if (playerStart < 0) playerStart = 0;
    const chestEnd = playerStart;

    const invBoneSlots = [];
    for (let i = playerStart; i < total; i++) {
      const it = win.slots[i];
      if (it && it.name === "bone_block") invBoneSlots.push(i);
    }
    if (invBoneSlots.length === 0) {
      log("No bone_block in inventory to sell");
      safeClose();
      return;
    }

    const freeSellSlots = [];
    for (let i = 0; i < chestEnd; i++) {
      if (!win.slots[i]) freeSellSlots.push(i);
    }
    if (freeSellSlots.length === 0) {
      log("No free sell slots in GUI", true);
      safeClose();
      return;
    }

    const moves = Math.min(invBoneSlots.length, freeSellSlots.length);
    for (let idx = 0; idx < moves; idx++) {
      const from = invBoneSlots[idx];
      const to = freeSellSlots[idx];
      log(`Moving bone_block from slot ${from} -> ${to}`);
      await bot.clickWindow(from, 0, 0);
      await sleep(150);
      await bot.clickWindow(to, 0, 0);
      await sleep(150);
    }

    log("Closing Sell GUI to complete sale");
    safeClose();
    await sleep(1000);  // Increased wait for inventory update
    totalSold += moves;
    log(`Batch sold: ${moves} bone blocks`);
  }
}

/* main loop */
async function mainLoop() {
  log("Main loop waiting for botReady");
  while (!botReady) await sleep(500);
  log("Main loop started", true);

  while (true) {
    if (stopRequested || botDisconnected) {
      isLoopRunning = false;
      log("Main loop stopped", true);
      return;
    }
    if (!bot.player) {
      log("bot.player missing, waiting");
      await sleep(1000);
      continue;
    }

    try {
      await craftBoneBlocksUntilLow();

      const blocks = countItems("bone_block");
      const bm = countItems("bone_meal");
      log(`Cycle: bone_block=${blocks}/${CONFIG.loop.targetBlocks}, bone_meal=${bm}`);

      if (blocks >= CONFIG.loop.targetBlocks) {
        log("Target blocks reached, selling", true);
        await sellSection();
        continue;
      }

      if (bm < 9) {
        const ok = await buyBoneMeal();
        if (ok) {
          await craftBoneBlocksUntilLow();
          continue;
        } else {
          if (blocks > 0) {
            log("Cannot buy, but have blocks -> sell", true);
            await sellSection();
            continue;
          } else {
            log("Cannot buy and no blocks, waiting", true);
            await medium();
            continue;
          }
        }
      } else {
        await craftBoneBlocksUntilLow();
      }

    } catch (err) {
      log("Loop error: " + err.message, true);
      await medium();
    }
  }
}

/* start */
createBot();
ipcLoop();
heartbeat();


