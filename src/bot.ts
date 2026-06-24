import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "./config.js";
import {
  addProject,
  addDailyLog,
  getPendingReminders,
  getProject,
  setNextAction,
  setStatus,
  stampProgress,
  type NewProject,
  type ProjectStatus,
  type ProjectType,
  type Reminder,
  PROJECT_STATUSES,
} from "./db.js";
import {
  buildStallSection,
  formatDailyMessage,
  formatProjectList,
} from "./messages.js";

/** Statuses the user may set via /done or /status. */
const SETTABLE_STATUSES: ProjectStatus[] = [
  ...PROJECT_STATUSES,
];

// --- Conversation state (in-memory, single authorized user) ---------------

interface AddDraft {
  kind: "add";
  step:
    | "name"
    | "type"
    | "revenue"
    | "confidence"
    | "time_to_cash"
    | "effort"
    | "next_action";
  data: Partial<NewProject>;
}

interface DoneFollowUp {
  kind: "done_next_action";
  projectId: number;
}

/** Awaiting the user's free-text reply to the evening check-in. */
interface CheckinSession {
  kind: "checkin";
}

type Session = AddDraft | DoneFollowUp | CheckinSession;

function parse1to5(text: string): number | null {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

function parseHours(text: string): number | null {
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

export interface OperatorBot {
  bot: Telegraf;
  /** Send today's allocation to the authorized chat. */
  sendDailyMessage: () => Promise<void>;
  /** Send the evening check-in prompt and arm the reply capture. */
  sendCheckinMessage: () => Promise<void>;
  /** Deliver an arbitrary notification to the authorized chat. */
  sendNotification: (message: string) => Promise<void>;
}

/** One line per pending reminder for the /reminders command. */
function formatReminder(r: Reminder): string {
  if (r.recurring && r.cron) {
    return `\u23F0 #${r.id} (repeats: ${r.cron}) — ${r.message}`;
  }
  if (r.due_at) {
    const when = new Date(r.due_at);
    const pretty = Number.isNaN(when.getTime()) ? r.due_at : when.toLocaleString();
    return `\u23F0 #${r.id} (${pretty}) — ${r.message}`;
  }
  return `\u23F0 #${r.id} — ${r.message}`;
}

export function createBot(config: Config): OperatorBot {
  const bot = new Telegraf(config.telegramBotToken);
  const authorizedChatId = config.telegramChatId;

  // Per-user conversation state. Only one authorized user, but keyed by id.
  const sessions = new Map<string, Session>();

  // Gatekeeper: only the configured chat id may interact at all.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== authorizedChatId) {
      return; // silently ignore everyone else
    }
    return next();
  });

  bot.start((ctx) =>
    ctx.reply(
      [
        "\u2693 manoverboard.ai is online.",
        "",
        "Commands:",
        "/today — today's focus",
        "/list — active projects + scores",
        "/add — add a project (guided)",
        "/next {id} {text} — set next action",
        "/done {id} — mark next action done",
        "/progress {id} [note] — log progress (resets the stall clock)",
        "/status {id} {status} — update status",
        "/reminders — list scheduled notifications",
      ].join("\n")
    )
  );

  bot.command("today", async (ctx) => {
    await ctx.reply(formatDailyMessage(config.stallDays));
  });

  bot.command("reminders", async (ctx) => {
    const pending = getPendingReminders();
    if (pending.length === 0) {
      await ctx.reply(
        "No scheduled notifications. Ask the assistant to schedule one."
      );
      return;
    }
    await ctx.reply(
      ["\uD83D\uDCC5 Scheduled notifications:", ...pending.map(formatReminder)].join(
        "\n"
      )
    );
  });

  bot.command("list", async (ctx) => {
    await ctx.reply(formatProjectList());
  });

  // /next {id} {text}
  bot.command("next", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    if (id === null || remainder.trim() === "") {
      await ctx.reply("Usage: /next {id} {the next concrete step}");
      return;
    }
    if (!getProject(id)) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    setNextAction(id, remainder.trim());
    stampProgress(id);
    await ctx.reply(`\u2705 Next action for #${id} updated.`);
  });

  // /status {id} {status}
  bot.command("status", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    const status = remainder.trim().toLowerCase() as ProjectStatus;
    if (id === null || !SETTABLE_STATUSES.includes(status)) {
      await ctx.reply(
        `Usage: /status {id} {${SETTABLE_STATUSES.join("|")}}`
      );
      return;
    }
    if (!getProject(id)) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    setStatus(id, status);
    await ctx.reply(`\u2705 #${id} is now "${status}".`);
  });

  // /done {id} — mark current next action complete, prompt for the new one.
  bot.command("done", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id } = splitIdAndRest(rest);
    if (id === null) {
      await ctx.reply("Usage: /done {id}");
      return;
    }
    const project = getProject(id);
    if (!project) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    stampProgress(id);
    sessions.set(authorizedChatId, { kind: "done_next_action", projectId: id });
    await ctx.reply(
      [
        `\uD83C\uDF89 Nice — marked "${project.next_action ?? "(no action)"}" done for ${project.name}.`,
        "",
        "What's the new next action? Reply with the next step,",
        `or send /status ${id} shipped | paid | blocked if it's finished/stuck.`,
      ].join("\n")
    );
  });

  // /progress {id} [note] — stamp progress without changing the next action.
  bot.command("progress", async (ctx) => {
    const rest = stripCommand(ctx.message.text);
    const { id, remainder } = splitIdAndRest(rest);
    if (id === null) {
      await ctx.reply("Usage: /progress {id} [optional note]");
      return;
    }
    const project = getProject(id);
    if (!project) {
      await ctx.reply(`No project with id ${id}.`);
      return;
    }
    stampProgress(id);
    const note = remainder.trim();
    if (note) {
      addDailyLog(`#${id} ${project.name}: ${note}`);
    }
    await ctx.reply(
      `\u2705 Logged progress on #${id} (${project.name}).${note ? " Note saved." : ""}`
    );
  });

  // /skip — only meaningful as a reply to the evening check-in.
  bot.command("skip", async (ctx) => {
    const session = sessions.get(authorizedChatId);
    if (session?.kind === "checkin") {
      sessions.delete(authorizedChatId);
      const stalls = buildStallSection(config.stallDays);
      await ctx.reply(
        stalls
          ? `No check-in logged tonight.\n\n${stalls}`
          : "No check-in logged tonight. Nothing stalling — nice."
      );
    } else {
      await ctx.reply("Nothing to skip.");
    }
  });

  // /add — guided, one question at a time.
  bot.command("add", async (ctx) => {
    sessions.set(authorizedChatId, {
      kind: "add",
      step: "name",
      data: {},
    });
    await ctx.reply("Adding a project. What's its name? (or /cancel)");
  });

  bot.command("cancel", async (ctx) => {
    if (sessions.delete(authorizedChatId)) {
      await ctx.reply("Cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  // Free-text handler drives /add, the /done follow-up, and the check-in reply.
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // commands handled above

    const session = sessions.get(authorizedChatId);
    if (!session) return; // nothing in progress; ignore stray text

    // /add takes priority so a check-in firing mid-add can't collide with it.
    if (session.kind === "add") {
      await handleAddStep(ctx, session, sessions, authorizedChatId, text);
      return;
    }

    if (session.kind === "done_next_action") {
      setNextAction(session.projectId, text.trim());
      stampProgress(session.projectId);
      sessions.delete(authorizedChatId);
      await ctx.reply(`\u2705 New next action set for #${session.projectId}.`);
      return;
    }

    if (session.kind === "checkin") {
      addDailyLog(text.trim());
      sessions.delete(authorizedChatId);
      const stalls = buildStallSection(config.stallDays);
      await ctx.reply(
        stalls
          ? `\u2705 Logged. Thanks.\n\n${stalls}`
          : "\u2705 Logged. Thanks. Nothing stalling right now — nice."
      );
      return;
    }
  });

  const sendDailyMessage = async (): Promise<void> => {
    await bot.telegram.sendMessage(
      authorizedChatId,
      formatDailyMessage(config.stallDays)
    );
  };

  const sendCheckinMessage = async (): Promise<void> => {
    // Don't clobber an in-progress flow (e.g. /add); it keeps priority.
    if (!sessions.has(authorizedChatId)) {
      sessions.set(authorizedChatId, { kind: "checkin" });
    }
    await bot.telegram.sendMessage(
      authorizedChatId,
      "\uD83C\uDF19 What did you move forward today? Reply with what you got done, or /skip."
    );
  };

  const sendNotification = async (message: string): Promise<void> => {
    await bot.telegram.sendMessage(authorizedChatId, message);
  };

  return { bot, sendDailyMessage, sendCheckinMessage, sendNotification };
}

async function handleAddStep(
  ctx: { reply: (s: string) => Promise<unknown> },
  session: AddDraft,
  sessions: Map<string, Session>,
  chatId: string,
  text: string
): Promise<void> {
  const value = text.trim();
  const d = session.data;

  switch (session.step) {
    case "name":
      d.name = value;
      session.step = "type";
      await ctx.reply("Type? Reply 'fast' (client/income) or 'passive'.");
      return;

    case "type": {
      const t = value.toLowerCase();
      if (t !== "fast" && t !== "passive") {
        await ctx.reply("Please reply exactly 'fast' or 'passive'.");
        return;
      }
      d.type = t as ProjectType;
      session.step = "revenue";
      await ctx.reply("Revenue potential? 1-5 (5 = big money).");
      return;
    }

    case "revenue": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.revenue_potential = n;
      session.step = "confidence";
      await ctx.reply("Confidence someone actually pays? 1-5.");
      return;
    }

    case "confidence": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.confidence = n;
      session.step = "time_to_cash";
      await ctx.reply("Time to cash? 1-5 (1 = paid within days, 5 = months/never).");
      return;
    }

    case "time_to_cash": {
      const n = parse1to5(value);
      if (n === null) {
        await ctx.reply("Please reply with a number 1-5.");
        return;
      }
      d.time_to_cash = n;
      session.step = "effort";
      await ctx.reply("Effort remaining in hours? (whole number)");
      return;
    }

    case "effort": {
      const n = parseHours(value);
      if (n === null) {
        await ctx.reply("Please reply with a number of hours (e.g. 8).");
        return;
      }
      d.effort_remaining = n;
      session.step = "next_action";
      await ctx.reply("What's the single concrete next action?");
      return;
    }

    case "next_action": {
      d.next_action = value;
      const project = addProject({
        name: d.name!,
        type: d.type!,
        revenue_potential: d.revenue_potential!,
        confidence: d.confidence!,
        time_to_cash: d.time_to_cash!,
        effort_remaining: d.effort_remaining!,
        next_action: d.next_action,
        status: "active",
      });
      sessions.delete(chatId);
      await ctx.reply(
        `\u2705 Added #${project.id} "${project.name}" (${project.type}, active).`
      );
      return;
    }
  }
}

/** Remove the leading "/command" (and optional @botname) token. */
function stripCommand(text: string): string {
  return text.replace(/^\/\S+\s*/, "");
}

/** Split "{id} rest of text" into a numeric id and the remainder. */
function splitIdAndRest(text: string): { id: number | null; remainder: string } {
  const trimmed = text.trim();
  const match = /^(\d+)\b\s*(.*)$/s.exec(trimmed);
  if (!match) return { id: null, remainder: trimmed };
  return { id: Number(match[1]), remainder: match[2] ?? "" };
}
