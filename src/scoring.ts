/**
 * Daily focus allocation for scored fast/passive projects.
 *
 * The app still supports project tasks, but the primary and secondary focus are
 * chosen from the scored project list so income work always wins over passive.
 */
import type { Project, ProjectTask, ProjectWithTasks } from "./db.js";

export interface FocusPick {
  project: Project;
  task: ProjectTask | null;
  action: string | null;
  score: number;
}

export interface DayAllocation {
  primary: FocusPick | null;
  secondary: FocusPick | null;
  openTaskCount: number;
  deadlineWarnings: Project[];
}

function openTasks(project: ProjectWithTasks): ProjectTask[] {
  return project.tasks.filter((t) => !t.done);
}

function nextOpenTask(project: ProjectWithTasks): ProjectTask | null {
  const pending = openTasks(project);
  return pending[0] ?? null;
}

function projectAction(project: ProjectWithTasks): string | null {
  const task = nextOpenTask(project);
  return task?.title ?? project.next_action ?? null;
}

function daysSince(isoDateTime: string): number | null {
  const past = new Date(isoDateTime);
  if (Number.isNaN(past.getTime())) return null;
  return Math.floor((Date.now() - past.getTime()) / 86_400_000);
}

export function scoreProject(project: Project): number {
  const speed = 6 - project.time_to_cash;
  return (
    (project.revenue_potential * project.confidence * Math.max(speed, 1)) /
    Math.max(project.effort_remaining, 1)
  );
}

export function daysUntil(dateText: string): number | null {
  const due = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - Date.now()) / 86_400_000);
}

function isAllocatable(project: ProjectWithTasks): boolean {
  return project.status === "active" && Boolean(projectAction(project));
}

function rankProjects(projects: ProjectWithTasks[]): ProjectWithTasks[] {
  return [...projects].sort((a, b) => {
    const byScore = scoreProject(b) - scoreProject(a);
    if (byScore !== 0) return byScore;

    const aDeadline = a.deadline ? daysUntil(a.deadline) : null;
    const bDeadline = b.deadline ? daysUntil(b.deadline) : null;
    if (aDeadline !== null && bDeadline !== null && aDeadline !== bDeadline) {
      return aDeadline - bDeadline;
    }
    if (aDeadline !== null) return -1;
    if (bDeadline !== null) return 1;

    const aProgress = a.last_progress_at ? new Date(a.last_progress_at).getTime() : 0;
    const bProgress = b.last_progress_at ? new Date(b.last_progress_at).getTime() : 0;
    return bProgress - aProgress;
  });
}

function toPick(project: ProjectWithTasks | null): FocusPick | null {
  if (!project) return null;
  const task = nextOpenTask(project);
  return {
    project,
    task,
    action: task?.title ?? project.next_action ?? null,
    score: scoreProject(project),
  };
}

function deadlineWarnings(projects: ProjectWithTasks[]): Project[] {
  return projects
    .filter((project) => project.status === "active" && project.deadline)
    .filter((project) => {
      const days = daysUntil(project.deadline!);
      return days !== null && days >= 0 && days <= 3;
    })
    .sort((a, b) => (daysUntil(a.deadline!) ?? Infinity) - (daysUntil(b.deadline!) ?? Infinity));
}

export function allocateDay(projects: ProjectWithTasks[]): DayAllocation {
  const ranked = rankProjects(projects);
  const openTaskCount = projects.reduce((n, p) => n + openTasks(p).length, 0);
  const fast = ranked.filter((project) => project.type === "fast" && isAllocatable(project));
  const passive = ranked.filter((project) => project.type === "passive" && isAllocatable(project));

  const primaryProject = fast[0] ?? null;
  const secondaryProject = passive[0] ?? null;

  return {
    primary: toPick(primaryProject),
    secondary: toPick(secondaryProject),
    openTaskCount,
    deadlineWarnings: deadlineWarnings(projects),
  };
}

export { daysSince };
