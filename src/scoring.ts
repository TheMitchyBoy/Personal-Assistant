/**
 * Daily focus allocation for ideas and their tasks.
 *
 * Picks active ideas with open tasks, preferring ideas that have been worked on
 * recently but still have incomplete tasks.
 */
import type { Project, ProjectTask, ProjectWithTasks } from "./db.js";

export interface FocusPick {
  project: Project;
  task: ProjectTask | null;
}

export interface DayAllocation {
  primary: FocusPick | null;
  secondary: FocusPick | null;
  openTaskCount: number;
}

function openTasks(project: ProjectWithTasks): ProjectTask[] {
  return project.tasks.filter((t) => !t.done);
}

function nextOpenTask(project: ProjectWithTasks): ProjectTask | null {
  const pending = openTasks(project);
  return pending[0] ?? null;
}

function daysSince(isoDateTime: string): number | null {
  const past = new Date(isoDateTime);
  if (Number.isNaN(past.getTime())) return null;
  return Math.floor((Date.now() - past.getTime()) / 86_400_000);
}

function rankIdeas(projects: ProjectWithTasks[]): ProjectWithTasks[] {
  const active = projects.filter((p) => p.status === "active" || p.status === "idea");
  return active
    .filter((p) => openTasks(p).length > 0)
    .sort((a, b) => {
      const aProgress = a.last_progress_at ? new Date(a.last_progress_at).getTime() : 0;
      const bProgress = b.last_progress_at ? new Date(b.last_progress_at).getTime() : 0;
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      return bProgress - aProgress;
    });
}

export function allocateDay(projects: ProjectWithTasks[]): DayAllocation {
  const ranked = rankIdeas(projects);
  const openTaskCount = projects.reduce((n, p) => n + openTasks(p).length, 0);

  const primaryProject = ranked[0] ?? null;
  const secondaryProject = ranked[1] ?? null;

  return {
    primary: primaryProject
      ? { project: primaryProject, task: nextOpenTask(primaryProject) }
      : null,
    secondary: secondaryProject
      ? { project: secondaryProject, task: nextOpenTask(secondaryProject) }
      : null,
    openTaskCount,
  };
}

export { daysSince };
