import cron, { type ScheduledTask } from "node-cron";
import { dailyTimeToCron, type Config } from "./config.js";

/**
 * Schedule the daily nudge. Fires once a day at config.dailyTime in the
 * configured timezone and calls `send` (which builds + delivers the message).
 */
export function startScheduler(
  config: Config,
  send: () => Promise<void>
): ScheduledTask {
  const expression = dailyTimeToCron(config.dailyTime);

  const task = cron.schedule(
    expression,
    () => {
      send().catch((err) => {
        console.error("[scheduler] failed to send daily message:", err);
      });
    },
    { timezone: config.tz }
  );

  console.log(
    `[scheduler] daily nudge scheduled at ${config.dailyTime} (${config.tz}) [cron: "${expression}"]`
  );

  return task;
}

/**
 * Schedule the evening check-in. Fires once a day at config.checkinTime in the
 * configured timezone and calls `send` (which prompts + arms reply capture).
 */
export function startCheckinScheduler(
  config: Config,
  send: () => Promise<void>
): ScheduledTask {
  const expression = dailyTimeToCron(config.checkinTime);

  const task = cron.schedule(
    expression,
    () => {
      send().catch((err) => {
        console.error("[scheduler] failed to send check-in:", err);
      });
    },
    { timezone: config.tz }
  );

  console.log(
    `[scheduler] evening check-in scheduled at ${config.checkinTime} (${config.tz}) [cron: "${expression}"]`
  );

  return task;
}
