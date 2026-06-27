/**
 * One-shot CLI entry — send today's allocation to a single user and exit.
 *
 * Usage: npm run daily -- user@example.com
 * Useful for external cron (GitHub Actions) when not running the long-lived process.
 */
import { loadConfig } from "./config.js";
import { initDb, getUserByEmail } from "./db.js";
import { createBot } from "./bot.js";

/**
 * One-shot: send today's allocation to a user and exit.
 * Usage: npm run daily -- user@example.com
 */
async function runOnce(): Promise<void> {
  const config = loadConfig();
  await initDb();

  const email = process.argv[2]?.trim();
  if (!email) {
    console.error("[daily] usage: npm run daily -- user@example.com");
    process.exit(1);
  }

  const user = await getUserByEmail(email);
  if (!user) {
    console.error(`[daily] no user found for ${email}`);
    process.exit(1);
  }
  if (!user.telegram_chat_id) {
    console.error(`[daily] ${email} has no linked Telegram — link it in the dashboard first.`);
    process.exit(1);
  }

  const { sendDailyMessage } = createBot(config);
  await sendDailyMessage(user);
  console.log(`[daily] sent today's allocation to ${email}.`);
}

runOnce()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[daily] failed:", err.message ?? err);
    process.exit(1);
  });
