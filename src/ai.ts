import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { getActiveProjects, getAllProjects, getGoals } from "./db.js";
import { allocateDay, score, daysSince } from "./scoring.js";
import { getStalledProjects } from "./db.js";
import type { Notifier, ReminderService } from "./reminders.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Capabilities the agent can act on. When provided, the model is given tools to
 * send and schedule Telegram notifications; without them it stays advisory.
 */
export interface AgentDeps {
  notifier?: Notifier;
  reminders?: ReminderService;
}

/** Keep token use bounded: only send the most recent turns. */
const MAX_HISTORY = 20;
const MAX_OUTPUT_TOKENS = 1024;
/** Hard cap on tool round-trips per chat request so a loop can't run away. */
const MAX_TOOL_ITERATIONS = 6;

export function isAiConfigured(config: Config): boolean {
  return config.anthropicApiKey.length > 0;
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** UTC offset string like "-05:00" for an IANA timezone at a given instant. */
function tzOffsetString(tz: string, date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name.replace(/^GMT/, "") || "+00:00";
  } catch {
    // Fall through to UTC on an unknown timezone.
  }
  return "+00:00";
}

/** Human + machine readable "now" so the model can compute schedule times. */
function describeNow(config: Config): string {
  const now = new Date();
  const offset = tzOffsetString(config.tz, now);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: config.tz,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `${local} ${config.tz} (UTC offset ${offset}); ISO now ${now.toISOString()}`;
}

/**
 * Build the system prompt from live data so the agent always reasons over the
 * current goals, projects, scores, and today's allocation.
 */
export function buildSystemPrompt(config: Config, hasTools = false): string {
  const goals = getGoals();
  const active = getActiveProjects();
  const all = getAllProjects();
  const allocation = allocateDay();
  const stalled = getStalledProjects(config.stallDays);

  const lines: string[] = [];

  lines.push(
    "You are the AI assistant for manoverboard.ai — a personal assistant and business analyst for a solo developer building a freelance/dev business on the side of a full-time job.",
    "",
    `Current time: ${describeNow(config)}.`,
    "",
    "How you think:",
    "- The user is time-poor: ~1 hour on weeknights, more on weekends. Keep suggestions realistic for that.",
    "- Two project tracks: 'fast' = client/services/paid software = income, ALWAYS the priority; 'passive' = ads/affiliate/own products = long game, only with leftover time.",
    "- Never dump the whole task list. Surface the ONE highest-leverage next move, then a little supporting context.",
    "- Priority score = (revenue_potential * confidence * (6 - time_to_cash)) / max(effort_remaining, 1). Higher = do sooner.",
    "- Be concrete and concise. No motivational fluff. Sharpen vague next actions into specific, shippable steps. Help rank, plan, and unblock.",
    ""
  );

  if (hasTools) {
    lines.push(
      "# Notifications (Telegram)",
      "You can send and schedule Telegram notifications to the user with your tools:",
      "- send_telegram_message: send a message to the user right now.",
      "- schedule_telegram_message: schedule a message for later — once (`when`, an ISO 8601 datetime WITH the user's timezone offset shown above) or recurring (`repeat_cron`, a 5-field cron expression in the user's timezone). Provide exactly one of the two.",
      "- list_scheduled_messages / cancel_scheduled_message: review or cancel what's scheduled.",
      "Guidance: when the user asks to be reminded/notified/pinged, actually call the tool — don't just say you will. Convert natural language times ('in 30 minutes', 'tomorrow 9am', 'every weekday morning') into the right `when` or `repeat_cron` using the current time above. Briefly confirm what you scheduled (including the time) in your reply.",
      ""
    );
  }

  lines.push("# Goals");
  if (goals.length === 0) {
    lines.push("(none set yet — encourage the user to define one)");
  } else {
    for (const g of goals) {
      lines.push(`- ${g.title}${g.detail ? ` — ${g.detail}` : ""}`);
    }
  }
  lines.push("");

  lines.push("# Active projects");
  if (active.length === 0) {
    lines.push("(no active projects)");
  } else {
    for (const p of active) {
      const bits = [
        `score ${round1(score(p))}`,
        `rev ${p.revenue_potential}/5`,
        `conf ${p.confidence}/5`,
        `time_to_cash ${p.time_to_cash}/5`,
        `~${p.effort_remaining}h left`,
      ];
      if (p.deadline) bits.push(`deadline ${p.deadline}`);
      if (p.last_progress_at) {
        const d = daysSince(p.last_progress_at);
        if (d !== null) bits.push(`${d}d since progress`);
      }
      lines.push(
        `- #${p.id} [${p.type}] ${p.name}${p.client ? ` (client: ${p.client})` : ""} — ${bits.join(", ")}`
      );
      lines.push(`    next: ${p.next_action ?? "(none set)"}`);
      if (p.notes) lines.push(`    notes: ${p.notes}`);
    }
  }
  lines.push("");

  const nonActive = all.filter((p) => p.status !== "active");
  if (nonActive.length > 0) {
    lines.push("# Other projects (not active)");
    for (const p of nonActive) {
      lines.push(`- #${p.id} [${p.type}] ${p.name} — status: ${p.status}`);
    }
    lines.push("");
  }

  lines.push("# Today's allocation (computed by the formula)");
  if (allocation.primary) {
    lines.push(
      `- PRIMARY (income): #${allocation.primary.project.id} ${allocation.primary.project.name} — ${allocation.primary.project.next_action ?? "(no next action)"}`
    );
  } else {
    lines.push("- PRIMARY: none — no active fast/income projects. Push the user to find/close a client.");
  }
  if (allocation.secondary) {
    lines.push(
      `- Secondary (passive, max 30 min): #${allocation.secondary.project.id} ${allocation.secondary.project.name}`
    );
  }
  if (allocation.deadlineWarnings.length > 0) {
    lines.push(
      `- Deadlines within 3 days: ${allocation.deadlineWarnings.map((p) => `${p.name} (${p.deadline})`).join("; ")}`
    );
  }
  if (stalled.length > 0) {
    lines.push(
      `- Stalling (no progress in ${config.stallDays}+ days): ${stalled.map((p) => p.name).join("; ")}`
    );
  }

  return lines.join("\n");
}

/** Tool schemas exposed to the model when notification capabilities exist. */
function buildTools(deps: AgentDeps): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  if (deps.notifier) {
    tools.push({
      name: "send_telegram_message",
      description:
        "Send a Telegram notification to the user immediately. Use when the user wants to be pinged with something right now.",
      input_schema: {
        type: "object",
        properties: {
          message: { type: "string", description: "The exact text to send." },
        },
        required: ["message"],
      },
    });
  }
  if (deps.reminders) {
    tools.push(
      {
        name: "schedule_telegram_message",
        description:
          "Schedule a Telegram notification for later. Provide EITHER `when` (a one-off) OR `repeat_cron` (recurring), never both.",
        input_schema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The text to send when the reminder fires.",
            },
            when: {
              type: "string",
              description:
                "One-off delivery time as an ISO 8601 datetime WITH a timezone offset, e.g. 2026-06-24T15:00:00-05:00.",
            },
            repeat_cron: {
              type: "string",
              description:
                "Recurring schedule as a 5-field cron expression in the user's timezone, e.g. '0 9 * * 1-5' = 9:00am every weekday.",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "list_scheduled_messages",
        description:
          "List the user's pending scheduled Telegram notifications (one-off and recurring).",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "cancel_scheduled_message",
        description: "Cancel a pending scheduled Telegram notification by its id.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "number", description: "The reminder id to cancel." },
          },
          required: ["id"],
        },
      }
    );
  }
  return tools;
}

/** Execute one tool call and return a short text result for the model. */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  deps: AgentDeps
): Promise<string> {
  switch (name) {
    case "send_telegram_message": {
      if (!deps.notifier) return "Error: Telegram sending is not available.";
      const message = String(input.message ?? "").trim();
      if (!message) return "Error: message is empty.";
      try {
        await deps.notifier(message);
        return "Sent to Telegram.";
      } catch (err) {
        return `Error sending: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "schedule_telegram_message": {
      if (!deps.reminders) return "Error: scheduling is not available.";
      try {
        const reminder = deps.reminders.schedule({
          message: String(input.message ?? ""),
          when: input.when != null ? String(input.when) : null,
          repeatCron: input.repeat_cron != null ? String(input.repeat_cron) : null,
          source: "agent",
        });
        if (reminder.recurring) {
          return `Scheduled recurring reminder #${reminder.id} (cron "${reminder.cron}").`;
        }
        return `Scheduled one-off reminder #${reminder.id} for ${reminder.due_at}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "list_scheduled_messages": {
      if (!deps.reminders) return "Error: scheduling is not available.";
      const pending = deps.reminders.listPending();
      if (pending.length === 0) return "No pending scheduled notifications.";
      return JSON.stringify(
        pending.map((r) => ({
          id: r.id,
          message: r.message,
          when: r.due_at,
          repeat_cron: r.cron,
          recurring: Boolean(r.recurring),
        }))
      );
    }
    case "cancel_scheduled_message": {
      if (!deps.reminders) return "Error: scheduling is not available.";
      const id = Number(input.id);
      if (!Number.isInteger(id)) return "Error: id must be a number.";
      return deps.reminders.cancel(id)
        ? `Cancelled reminder #${id}.`
        : `No pending reminder #${id} to cancel.`;
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

function textFromContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Send a conversation to the model and return the assistant's text reply. When
 * `deps` provides notification capabilities, the model can call tools to send or
 * schedule Telegram messages, looping until it produces a final text answer.
 * Throws if the AI agent isn't configured.
 */
export async function chat(
  config: Config,
  messages: ChatMessage[],
  deps: AgentDeps = {}
): Promise<string> {
  if (!isAiConfigured(config)) {
    throw new Error("AI agent is not configured (set ANTHROPIC_API_KEY).");
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const trimmed = messages.slice(-MAX_HISTORY);
  const tools = buildTools(deps);
  const system = buildSystemPrompt(config, tools.length > 0);

  const convo: Anthropic.MessageParam[] = trimmed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let lastText = "";
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: convo,
      ...(tools.length > 0 ? { tools } : {}),
    });

    const text = textFromContent(response.content);
    if (text) lastText = text;

    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Record the assistant's tool_use turn, then answer each tool call.
    convo.push({ role: "assistant", content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await runTool(
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
          deps
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
  }

  return lastText || "(the assistant returned no text)";
}
