/**
 * Priority scoring and daily task allocation.
 *
 * Core business rules live here and are shared by the bot, scheduler, dashboard
 * AI, and one-shot `npm run daily`:
 *
 *   - Projects split into `fast` (income) and `passive` (long-game) queues
 *   - Primary task always comes from the highest-scoring fast project
 *   - Secondary is optional passive work — never replaces missing fast work
 *   - Deadline warnings surface projects due within 3 days
 */
import type { Project } from "./db.js";

export interface ScoredProject {
  project: Project;
  score: number;
}

export interface DayAllocation {
  primary: ScoredProject | null;
  secondary: ScoredProject | null;
  deadlineWarnings: Project[];
  noFastWork: boolean;
}

export function score(p: Project): number {
  // Invert time_to_cash so "paid within days" (1) scores higher than "months" (5).
  const speed = 6 - p.time_to_cash;
  return (p.revenue_potential * p.confidence * speed) / Math.max(p.effort_remaining, 1);
}

function scoreAndSort(projects: Project[]): ScoredProject[] {
  return projects
    .map((project) => ({ project, score: score(project) }))
    .sort((a, b) => b.score - a.score);
}

function daysSince(isoDateTime: string): number | null {
  const past = new Date(isoDateTime);
  if (Number.isNaN(past.getTime())) return null;
  return Math.floor((Date.now() - past.getTime()) / 86_400_000);
}

function daysUntil(isoDate: string): number | null {
  const target = new Date(isoDate);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  const t = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const n = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t - n) / 86_400_000);
}

export function allocateDay(projects: Project[]): DayAllocation {
  const active = projects.filter((p) => p.status === "active");

  const fast = scoreAndSort(active.filter((p) => p.type === "fast"));
  const passive = scoreAndSort(active.filter((p) => p.type === "passive"));

  // Surface imminent deadlines regardless of score — sorted soonest first.
  const deadlineWarnings = active
    .filter((p) => {
      if (!p.deadline) return false;
      const d = daysUntil(p.deadline);
      return d !== null && d <= 3;
    })
    .sort((a, b) => (daysUntil(a.deadline!) ?? 0) - (daysUntil(b.deadline!) ?? 0));

  return {
    primary: fast[0] ?? null,
    secondary: passive[0] ?? null,
    deadlineWarnings,
    noFastWork: fast.length === 0,
  };
}

export { daysUntil, daysSince };
