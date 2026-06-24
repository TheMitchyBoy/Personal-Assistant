import cron, { type ScheduledTask } from "node-cron";
import type { Config } from "./config.js";
import {
  addReminder,
  cancelReminder as cancelReminderDb,
  getActiveRecurringReminders,
  getDueOneOffReminders,
  getPendingReminders,
  getReminder,
  markReminderSent,
  stampReminderRun,
  type Reminder,
} from "./db.js";

/** Delivers a message to the operator (in practice, the Telegram chat). */
export type Notifier = (message: string) => Promise<void>;

export interface ScheduleInput {
  message: string;
  /** ISO 8601 datetime (with timezone offset) for a one-off reminder. */
  when?: string | null;
  /** node-cron expression (evaluated in config.tz) for a recurring reminder. */
  repeatCron?: string | null;
  /** Free-text tag for who created it, e.g. "agent". */
  source?: string | null;
}

export interface ReminderService {
  /** Begin polling for due one-off reminders and arm recurring cron tasks. */
  start(): void;
  /** Stop the poller and every recurring task (used on shutdown). */
  stop(): void;
  /** Validate + persist a reminder, arming it immediately if recurring. */
  schedule(input: ScheduleInput): Reminder;
  /** Cancel a pending reminder; also tears down its recurring task. */
  cancel(id: number): boolean;
  /** Pending reminders (one-off not yet sent + active recurring). */
  listPending(): Reminder[];
}

/** Poll cadence for one-off reminders: once a minute is plenty for nudges. */
const POLL_CRON = "* * * * *";

export function createReminderService(
  config: Config,
  notify: Notifier
): ReminderService {
  // Live cron tasks for recurring reminders, keyed by reminder id.
  const recurringTasks = new Map<number, ScheduledTask>();
  let pollTask: ScheduledTask | null = null;

  const deliver = async (reminder: Reminder): Promise<void> => {
    await notify(reminder.message);
  };

  const runDueOneOffs = async (): Promise<void> => {
    const due = getDueOneOffReminders(new Date().toISOString());
    for (const reminder of due) {
      try {
        await deliver(reminder);
        markReminderSent(reminder.id);
      } catch (err) {
        console.error(
          `[reminders] failed to send one-off #${reminder.id}:`,
          err
        );
      }
    }
  };

  const armRecurring = (reminder: Reminder): void => {
    if (reminder.cron === null || recurringTasks.has(reminder.id)) return;
    if (!cron.validate(reminder.cron)) {
      console.error(
        `[reminders] recurring #${reminder.id} has an invalid cron "${reminder.cron}" — skipping.`
      );
      return;
    }
    const task = cron.schedule(
      reminder.cron,
      () => {
        // Re-read so a cancellation between firings is respected.
        const current = getReminder(reminder.id);
        if (!current || current.status !== "pending") return;
        deliver(current)
          .then(() => stampReminderRun(current.id))
          .catch((err) =>
            console.error(
              `[reminders] failed to send recurring #${current.id}:`,
              err
            )
          );
      },
      { timezone: config.tz }
    );
    recurringTasks.set(reminder.id, task);
  };

  return {
    start(): void {
      for (const reminder of getActiveRecurringReminders()) {
        armRecurring(reminder);
      }
      pollTask = cron.schedule(
        POLL_CRON,
        () => {
          runDueOneOffs().catch((err) =>
            console.error("[reminders] poll failed:", err)
          );
        },
        { timezone: config.tz }
      );
      // Catch anything already overdue at boot (e.g. while the app was down).
      runDueOneOffs().catch((err) =>
        console.error("[reminders] startup sweep failed:", err)
      );
      console.log(
        `[reminders] scheduler started (polling one-offs every minute, ${recurringTasks.size} recurring armed)`
      );
    },

    stop(): void {
      pollTask?.stop();
      pollTask = null;
      for (const task of recurringTasks.values()) task.stop();
      recurringTasks.clear();
    },

    schedule(input: ScheduleInput): Reminder {
      const message = input.message?.trim();
      if (!message) {
        throw new Error("message is required");
      }

      const when = input.when?.trim() || null;
      const repeatCron = input.repeatCron?.trim() || null;

      if (!when && !repeatCron) {
        throw new Error(
          "provide either `when` (one-off ISO 8601 datetime) or `repeatCron` (recurring cron expression)"
        );
      }
      if (when && repeatCron) {
        throw new Error(
          "provide only one of `when` or `repeatCron`, not both"
        );
      }

      if (repeatCron) {
        if (!cron.validate(repeatCron)) {
          throw new Error(
            `invalid cron expression "${repeatCron}" (use 5 fields, e.g. "0 9 * * 1" for 9am every Monday)`
          );
        }
        const reminder = addReminder({
          message,
          cron: repeatCron,
          recurring: true,
          source: input.source ?? null,
        });
        armRecurring(reminder);
        return reminder;
      }

      const dueDate = new Date(when!);
      if (Number.isNaN(dueDate.getTime())) {
        throw new Error(
          `could not parse \`when\` ("${when}") — use ISO 8601 with a timezone offset, e.g. 2026-06-24T15:00:00-05:00`
        );
      }
      if (dueDate.getTime() < Date.now() - 60_000) {
        throw new Error(
          `\`when\` (${dueDate.toISOString()}) is in the past — pick a future time`
        );
      }

      return addReminder({
        message,
        due_at: dueDate.toISOString(),
        recurring: false,
        source: input.source ?? null,
      });
    },

    cancel(id: number): boolean {
      const ok = cancelReminderDb(id);
      const task = recurringTasks.get(id);
      if (task) {
        task.stop();
        recurringTasks.delete(id);
      }
      return ok;
    },

    listPending(): Reminder[] {
      return getPendingReminders();
    },
  };
}
