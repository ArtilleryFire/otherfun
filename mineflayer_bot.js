// Mineflayer registration bot
//
// This script uses the mineflayer library to connect to an offline (cracked)
// Minecraft server and register a new AuthMe account.  It prompts the user for a
// username and password via the console before connecting.  Once the bot
// spawns on the server it sends a `/register` command using the provided
// credentials and then logs all chat messages to the console.
//
// Before running this script you need to install the mineflayer package:
//    npm install mineflayer
// Then run the bot with Node.js:
//    node mineflayer_bot.js

const mineflayer = require('mineflayer');
const readline = require('readline');

// Helper to prompt the user for input
function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  try {
    // Prompt for a username and password.  These will be used to create the
    // account on the cracked server via the `/register` command.  The
    // username is also used to connect to the server; no Mojang authentication
    // is performed because the server is in offline mode【250972018556710†L150-L158】.
    const username = await ask('Enter a username for the bot: ');
    const password = await ask('Enter a password (for /register): ');

    if (!username || !password) {
      console.log('Username and password are required.');
      return;
    }

    // Number of times we've attempted to connect
    let attempts = 0;
    const maxAttempts = 10;

    // Define a function that tries to connect.  If the connection is reset or
    // ends unexpectedly, it will retry up to maxAttempts times.  On the final
    // failure it logs "FAILED TO CONNECT".
    const connect = () => {
      attempts++;
      console.log(`Attempt ${attempts} of ${maxAttempts}: connecting to alwination.id as ${username}...`);

      const bot = mineflayer.createBot({
        host: 'play.craftnesia.my.id',
        port: 25565,
        username: username,
      });

      bot.once('spawn', () => {
        console.log('Bot spawned on the server. Sending register command...');
        const registerCommand = `/register ${password}`;
        bot.chat(registerCommand);
        const aftermath = `/joinq survival`;
        bot.chat(aftermath);
        console.log('joining survival');
        const test1 = `/login`;
        const test2 = `/register`;
        bot.chat(test1);
        bot.chat(test2);
      })

      bot.on('chat', (sender, message) => {
        console.log(`[${sender}] ${message}`);
      });

      // On any error, attempt to reconnect if we haven't reached maxAttempts.
      bot.on('error', (err) => {
        console.error('Bot encountered an error:', err);
        if (attempts < maxAttempts) {
          // Allow time for cleanup before reconnecting
          setTimeout(connect, 2000);
        } else {
          console.error('FAILED TO CONNECT');
        }
      });

      // If the connection ends unexpectedly (e.g. ECONNRESET), try to reconnect.
      bot.on('end', () => {
        console.log('Bot disconnected from the server.');
        if (attempts < maxAttempts) {
          setTimeout(connect, 1000);
        } else {
          console.error('FAILED TO CONNECT');
        }
      });
    };

    // Initiate the first connection attempt
    connect();
  } catch (err) {
    console.error(err);
  }
}

main();
