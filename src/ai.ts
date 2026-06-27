/**
 * Optional AI assistant — suggests and manages ideas and their tasks.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import {
  addGoal,
  addProject,
  addProjectTask,
  getAllProjectsWithTasks,
  getGoals,
  getProjectWithTasks,
  getStalledProjects,
  getUserById,
  updateProject,
  type NewProject,
  type ProjectPatch,
  type ProjectStatus,
} from "./db.js";
import { allocateDay } from "./scoring.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatAction {
  type: "created_project" | "updated_project" | "created_goal" | "added_tasks";
  id: number;
  name?: string;
  title?: string;
  taskCount?: number;
}

export interface ChatResult {
  reply: string;
  actions: ChatAction[];
}

const MAX_HISTORY = 20;
const MAX_OUTPUT_TOKENS = 2048;
const MAX_TOOL_ROUNDS = 6;
const UI_STATUSES: ProjectStatus[] = ["idea", "active", "blocked", "shipped", "archived"];

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_idea",
    description:
      "Add a new idea the user wants to explore. Include a short description and 2-5 concrete starter tasks when possible.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short idea title" },
        description: { type: "string", description: "What the idea is about and why it matters" },
        status: { type: "string", enum: ["idea", "active", "blocked", "shipped", "archived"] },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Concrete tasks that move this idea forward",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_idea",
    description: "Update an existing idea's title, description, or status.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["idea", "active", "blocked", "shipped", "archived"] },
      },
      required: ["id"],
    },
  },
  {
    name: "add_tasks",
    description:
      "Add one or more tasks to an existing idea. Use when suggesting next steps or when the user agrees to your task list.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Idea id" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Task titles — specific and actionable",
        },
      },
      required: ["project_id", "tasks"],
    },
  },
  {
    name: "create_goal",
    description: "Add a high-level goal that frames what the user's ideas are working toward.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
      },
      required: ["title"],
    },
  },
];

export function isAiConfigured(config: Config): boolean {
  return config.anthropicApiKey.length > 0;
}

function toNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function parseTasks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
}

function validateNewIdea(body: Record<string, unknown>): { value: NewProject } | { error: string } {
  const name = toNullableString(body.name);
  if (!name) return { error: "name is required" };
  const status = String(body.status ?? "idea").trim() as ProjectStatus;
  if (!UI_STATUSES.includes(status)) {
    return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
  }
  const tasks = parseTasks(body.tasks);
  return {
    value: {
      name,
      notes: toNullableString(body.description ?? body.notes),
      status,
      tasks: tasks.length ? tasks : undefined,
    },
  };
}

function validateIdeaPatch(body: Record<string, unknown>): { value: ProjectPatch } | { error: string } {
  const patch: ProjectPatch = {};
  if ("name" in body) {
    const name = toNullableString(body.name);
    if (!name) return { error: "name cannot be empty" };
    patch.name = name;
  }
  if ("description" in body || "notes" in body) {
    patch.notes = toNullableString(body.description ?? body.notes);
  }
  if ("status" in body) {
    const status = String(body.status ?? "").trim() as ProjectStatus;
    if (!UI_STATUSES.includes(status)) {
      return { error: `status must be one of ${UI_STATUSES.join(", ")}` };
    }
    patch.status = status;
  }
  return { value: patch };
}

interface ToolRunResult {
  output: Record<string, unknown>;
  actions: ChatAction[];
}

async function runTool(userId: number, name: string, input: unknown): Promise<ToolRunResult> {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (name === "create_idea" || name === "create_project") {
    const result = validateNewIdea(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    const project = await addProject(userId, result.value);
    return {
      output: {
        ok: true,
        idea: { id: project.id, name: project.name, status: project.status },
        tasks_added: result.value.tasks?.length ?? 0,
      },
      actions: [
        {
          type: "created_project",
          id: project.id,
          name: project.name,
          taskCount: result.value.tasks?.length ?? 0,
        },
      ],
    };
  }

  if (name === "update_idea" || name === "update_project") {
    const id = toInt(body.id);
    if (id === null) return { output: { ok: false, error: "id must be an integer" }, actions: [] };
    const result = validateIdeaPatch(body);
    if ("error" in result) return { output: { ok: false, error: result.error }, actions: [] };
    if (Object.keys(result.value).length === 0) {
      return { output: { ok: false, error: "no fields to update" }, actions: [] };
    }
    const updated = await updateProject(userId, id, result.value);
    if (!updated) return { output: { ok: false, error: `no idea #${id}` }, actions: [] };
    return {
      output: { ok: true, idea: { id: updated.id, name: updated.name, status: updated.status } },
      actions: [{ type: "updated_project", id: updated.id, name: updated.name }],
    };
  }

  if (name === "add_tasks") {
    const projectId = toInt(body.project_id ?? body.id);
    if (projectId === null) {
      return { output: { ok: false, error: "project_id must be an integer" }, actions: [] };
    }
    const idea = await getProjectWithTasks(userId, projectId);
    if (!idea) return { output: { ok: false, error: `no idea #${projectId}` }, actions: [] };
    const tasks = parseTasks(body.tasks);
    if (!tasks.length) return { output: { ok: false, error: "tasks array is required" }, actions: [] };
    const added = [];
    for (const title of tasks) {
      added.push(await addProjectTask(userId, projectId, title));
    }
    return {
      output: { ok: true, added: added.map((t) => ({ id: t.id, title: t.title })) },
      actions: [{ type: "added_tasks", id: projectId, name: idea.name, taskCount: added.length }],
    };
  }

  if (name === "create_goal") {
    const title = toNullableString(body.title);
    if (!title) return { output: { ok: false, error: "title is required" }, actions: [] };
    const goal = await addGoal(userId, title, toNullableString(body.detail));
    return {
      output: { ok: true, goal: { id: goal.id, title: goal.title } },
      actions: [{ type: "created_goal", id: goal.id, title: goal.title }],
    };
  }

  return { output: { ok: false, error: `unknown tool: ${name}` }, actions: [] };
}

export async function buildSystemPrompt(userId: number): Promise<string> {
  const user = await getUserById(userId);
  const stallDays = user?.stall_days ?? 4;
  const goals = await getGoals(userId);
  const ideas = await getAllProjectsWithTasks(userId);
  const allocation = allocateDay(ideas);
  const stalled = await getStalledProjects(userId, stallDays);

  const lines: string[] = [];

  lines.push(
    "You are the AI assistant for Concierge — a productivity partner for capturing ideas and breaking them into actionable tasks.",
    "",
    "How you work:",
    "- The user tracks **ideas** (general concepts, projects, experiments) each with a description and a list of **tasks**.",
    "- Your main job: suggest concrete, small tasks that move an idea forward. Think next physical actions, not vague goals.",
    "- When an idea is thin, ask one clarifying question OR propose 3-5 starter tasks and offer to add them.",
    "- Prefer adding tasks via tools when the user agrees ('yes', 'add those', 'sounds good').",
    "- Be concise. No motivational fluff. Tasks should be doable in an evening or weekend session.",
    "",
    "Tools:",
    "- create_idea: new idea + optional description + starter tasks",
    "- update_idea: change title, description, or status",
    "- add_tasks: append tasks to an existing idea by project_id",
    "- create_goal: add a north-star goal",
    ""
  );

  lines.push("# Goals");
  if (goals.length === 0) {
    lines.push("(none — help the user define one if useful)");
  } else {
    for (const g of goals) {
      lines.push(`- #${g.id} ${g.title}${g.detail ? ` — ${g.detail}` : ""}`);
    }
  }
  lines.push("");

  lines.push("# Ideas and tasks");
  if (ideas.length === 0) {
    lines.push("(none yet — encourage capturing a rough idea and breaking it into tasks)");
  } else {
    for (const idea of ideas) {
      const open = idea.tasks.filter((t) => !t.done);
      const done = idea.tasks.filter((t) => t.done);
      lines.push(`- #${idea.id} [${idea.status}] ${idea.name}`);
      if (idea.notes) lines.push(`    description: ${idea.notes}`);
      if (open.length) {
        lines.push(`    open tasks: ${open.map((t) => `"${t.title}"`).join("; ")}`);
      } else {
        lines.push("    open tasks: (none — suggest some!)");
      }
      if (done.length) lines.push(`    done: ${done.length} task(s)`);
    }
  }
  lines.push("");

  lines.push("# Suggested focus today");
  if (allocation.primary) {
    const { project, task } = allocation.primary;
    lines.push(`- #${project.id} ${project.name} → ${task?.title ?? "(add a task)"}`);
  } else {
    lines.push("- No open tasks — suggest new ideas or tasks for existing ideas.");
  }
  if (allocation.secondary) {
    lines.push(
      `- Spare time: #${allocation.secondary.project.id} ${allocation.secondary.project.name}`
    );
  }
  if (stalled.length > 0) {
    lines.push(`- Stalling (${stallDays}+ days): ${stalled.map((p) => p.name).join("; ")}`);
  }

  return lines.join("\n");
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function parseSuggestionLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((line) => line.length > 3 && line.length < 200);
}

/** One-shot AI call to suggest tasks for a single idea. */
export async function suggestTasksForProject(
  config: Config,
  userId: number,
  projectId: number
): Promise<string[]> {
  if (!isAiConfigured(config)) {
    throw new Error("AI not configured (set ANTHROPIC_API_KEY).");
  }

  const idea = await getProjectWithTasks(userId, projectId);
  if (!idea) throw new Error("Idea not found");

  const open = idea.tasks.filter((t) => !t.done).map((t) => t.title);
  const done = idea.tasks.filter((t) => t.done).map((t) => t.title);

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system:
      "You suggest concrete, actionable tasks for ideas. Return ONLY a plain list — one task per line, no numbering, no intro. Each task should be doable in under 2 hours. Do not repeat existing tasks.",
    messages: [
      {
        role: "user",
        content: [
          `Idea: ${idea.name}`,
          idea.notes ? `Description: ${idea.notes}` : "",
          open.length ? `Existing open tasks: ${open.join("; ")}` : "No open tasks yet.",
          done.length ? `Already done: ${done.join("; ")}` : "",
          "",
          "Suggest 4-6 new tasks to move this idea forward.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const text = extractText(response.content);
  const lines = parseSuggestionLines(text);
  return lines.slice(0, 8);
}

export async function chat(
  config: Config,
  userId: number,
  messages: ChatMessage[]
): Promise<ChatResult> {
  if (!isAiConfigured(config)) {
    throw new Error("AI agent is not configured (set ANTHROPIC_API_KEY).");
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const trimmed = messages.slice(-MAX_HISTORY);
  const apiMessages: Anthropic.MessageParam[] = trimmed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const actions: ChatAction[] = [];
  let rounds = 0;
  const system = await buildSystemPrompt(userId);

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: TOOLS,
      messages: apiMessages,
    });

    if (response.stop_reason === "tool_use") {
      apiMessages.push({ role: "assistant", content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const { output, actions: newActions } = await runTool(userId, block.name, block.input);
        actions.push(...newActions);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(output),
        });
      }

      if (toolResults.length === 0) {
        return { reply: extractText(response.content) || "(tool call failed)", actions };
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    const reply = extractText(response.content) || "(the assistant returned no text)";
    return { reply, actions };
  }

  return {
    reply: "I hit the tool-use limit for this turn. Check your workspace — changes may have been saved.",
    actions,
  };
}
