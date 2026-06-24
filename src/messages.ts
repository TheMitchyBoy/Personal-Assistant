import {
  allocateDay,
  daysUntil,
  daysSince,
  score as scoreOf,
  type DayAllocation,
} from "./scoring.js";
import {
  getActiveProjects,
  getStalledProjects,
  type Project,
} from "./db.js";

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

/**
 * Build the "⚠️ Stalling" block for active projects past `stallDays`, or null
 * if nothing is stalling. Reused by the daily message and the evening check-in.
 */
export function buildStallSection(stallDays: number): string | null {
  const stalled = getStalledProjects(stallDays);
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

/**
 * Build the single daily focus message. Returns plain text (no markdown
 * parse_mode needed) so project names with special chars are safe.
 *
 * When `stallDays` is provided, a "⚠️ Stalling" section is appended; the
 * primary/secondary/deadline sections are untouched.
 */
export function formatDailyMessage(
  stallDays: number | null = null,
  allocation: DayAllocation = allocateDay()
): string {
  const lines: string[] = ["\u2600\uFE0F Today's focus", ""];

  if (allocation.deadlineWarnings.length > 0) {
    lines.push("\u23F0 Heads up:");
    for (const p of allocation.deadlineWarnings) {
      lines.push(deadlineLine(p));
    }
    lines.push("");
  }

  if (allocation.primary) {
    const { project, score } = allocation.primary;
    lines.push(`\uD83D\uDCB0 PRIMARY (income): ${project.name}`);
    lines.push(`\u2192 ${project.next_action ?? "(no next action set)"}`);
    lines.push(`Why: closest to getting paid (score ${roundScore(score)}).`);
  } else if (allocation.noFastWork) {
    lines.push("\uD83D\uDCB0 PRIMARY (income): none.");
    lines.push(
      "No active fast/income projects. Go find or close a client today — don't coast on passive work."
    );
  }

  if (allocation.secondary) {
    const { project } = allocation.secondary;
    lines.push("");
    lines.push(
      `\uD83C\uDF31 If you have 30 min spare: ${project.name}`
    );
    lines.push(`\u2192 ${project.next_action ?? "(no next action set)"}`);
    lines.push("(only if you have time after the above)");
  }

  lines.push("");
  lines.push("Reply /done {id} when you finish something.");

  if (stallDays !== null) {
    const stallSection = buildStallSection(stallDays);
    if (stallSection) {
      lines.push("");
      lines.push(stallSection);
    }
  }

  return lines.join("\n");
}

/** Compact one-line-per-project listing for /list. */
export function formatProjectList(): string {
  const active = getActiveProjects();
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
