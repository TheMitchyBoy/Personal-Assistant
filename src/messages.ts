/**
 * Telegram message formatting for ideas and tasks.
 */
import { allocateDay, daysSince, type DayAllocation } from "./scoring.js";
import {
  getAllProjectsWithTasks,
  getStalledProjects,
  type ProjectWithTasks,
} from "./db.js";

function stallLine(p: { id: number; name: string; last_progress_at: string | null }): string {
  if (!p.last_progress_at) {
    return `\u2022 ${p.name} (#${p.id}) — no recorded progress yet`;
  }
  const d = daysSince(p.last_progress_at) ?? 0;
  return `\u2022 ${p.name} (#${p.id}) — ${d} ${d === 1 ? "day" : "days"} since progress`;
}

export async function buildStallSection(
  userId: number,
  stallDays: number
): Promise<string | null> {
  const stalled = await getStalledProjects(userId, stallDays);
  if (stalled.length === 0) return null;

  const lines = ["\u26A0\uFE0F Stalling:"];
  for (const p of stalled) {
    lines.push(stallLine(p));
  }
  lines.push("Pick one small task and move an idea forward today.");
  return lines.join("\n");
}

export async function formatDailyMessage(
  userId: number,
  stallDays: number | null = null,
  allocation?: DayAllocation,
  projectsWithTasks?: ProjectWithTasks[]
): Promise<string> {
  const all = projectsWithTasks ?? (await getAllProjectsWithTasks(userId));
  const alloc = allocation ?? allocateDay(all);
  const lines: string[] = ["\u2600\uFE0F Today's focus", ""];

  if (alloc.primary) {
    const { project, task } = alloc.primary;
    lines.push(`\uD83D\uDCA1 Idea: ${project.name}`);
    if (task) {
      lines.push(`\u2192 ${task.title}`);
    } else {
      lines.push(`\u2192 Add a task to this idea, or pick up where you left off.`);
    }
  } else if (alloc.openTaskCount === 0) {
    lines.push("\uD83D\uDCA1 No open tasks on your ideas.");
    lines.push("Capture a new idea with /add or ask the dashboard AI to suggest tasks.");
  } else {
    lines.push("\uD83D\uDCA1 No active ideas with tasks — review your list and activate one.");
  }

  if (alloc.secondary) {
    const { project, task } = alloc.secondary;
    lines.push("");
    lines.push(`\u2728 If you have spare time: ${project.name}`);
    lines.push(`\u2192 ${task?.title ?? "(add a task)"}`);
  }

  lines.push("");
  lines.push("Reply /done {id} when you finish a task on an idea.");

  if (stallDays !== null) {
    const stallSection = await buildStallSection(userId, stallDays);
    if (stallSection) {
      lines.push("");
      lines.push(stallSection);
    }
  }

  return lines.join("\n");
}

export async function formatProjectList(userId: number): Promise<string> {
  const all = await getAllProjectsWithTasks(userId);
  const active = all.filter((p) => p.status === "active" || p.status === "idea");
  if (active.length === 0) {
    return "No ideas yet. Use /add to capture one.";
  }
  return active
    .map((p) => {
      const open = p.tasks.filter((t) => !t.done).length;
      const done = p.tasks.filter((t) => t.done).length;
      return `#${p.id} ${p.name} [${p.status}] — ${open} open, ${done} done`;
    })
    .join("\n");
}
