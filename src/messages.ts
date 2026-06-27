/**
 * Telegram message formatting.
 *
 * Turns scored projects into human-readable strings for `/today`, scheduled
 * nudges, and stall warnings. All paths call scoring.ts so bot and scheduler
 * stay in sync with the same allocation logic.
 */
import { allocateDay, daysUntil, daysSince, score as scoreOf, type DayAllocation } from "./scoring.js";
import { getActiveProjects, getStalledProjects, type Project } from "./db.js";

function roundScore(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function deadlineLine(p: Project): string {
  const d = daysUntil(p.deadline!);
  let when: string;
  if (d === null) when = p.deadline!;
  else if (d < 0) when = `${Math.abs(d)}d overdue`;
  else if (d === 0) when = "today";
  else if (d === 1) when = "tomorrow";
  else when = `in ${d}d`;
  return `• ${p.name} (#${p.id}) — due ${when}`;
}

function stallLine(p: Project): string {
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
  if (stalled.some((p) => p.type === "passive")) {
    lines.push("Passive projects: quietly letting them rot is how they die.");
  }
  return lines.join("\n");
}

export async function formatDailyMessage(
  userId: number,
  stallDays: number | null = null,
  allocation?: DayAllocation
): Promise<string> {
  const active = await getActiveProjects(userId);
  const alloc = allocation ?? allocateDay(active);
  const lines: string[] = ["\u2600\uFE0F Today's focus", ""];

  if (alloc.deadlineWarnings.length > 0) {
    lines.push("\uD83D\uDEA8 On the horizon:");
    for (const p of alloc.deadlineWarnings) {
      lines.push(deadlineLine(p));
    }
    lines.push("");
  }

  if (alloc.primary) {
    const { project, score } = alloc.primary;
    lines.push(`\uD83D\uDCB0 PRIMARY (income): ${project.name}`);
    lines.push(`\u2192 ${project.next_action ?? "(no next action set)"}`);
    lines.push(`Why: closest to getting paid (score ${roundScore(score)}).`);
  } else if (alloc.noFastWork) {
    lines.push("\uD83D\uDCB0 PRIMARY (income): none.");
    lines.push(
      "No active fast/income projects. Go find or close a client today — don't coast on passive work."
    );
  }

  if (alloc.secondary) {
    const { project } = alloc.secondary;
    lines.push("");
    lines.push(`\uD83C\uDF31 If you have 30 min spare: ${project.name}`);
    lines.push(`\u2192 ${project.next_action ?? "(no next action set)"}`);
    lines.push("(only if you have time after the above)");
  }

  lines.push("");
  lines.push("Reply /done {id} when you finish something.");

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
  const active = await getActiveProjects(userId);
  if (active.length === 0) {
    return "No active projects. Use /add to create one.";
  }
  return active
    .map((p) => {
      const s = roundScore(scoreOf(p));
      const type = p.type === "fast" ? "\uD83D\uDCB0fast" : "\uD83C\uDF31passive";
      return `#${p.id} ${p.name} [${type}] score ${s}`;
    })
    .join("\n");
}
