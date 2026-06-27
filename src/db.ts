/**
 * PostgreSQL data layer.
 *
 * Owns the connection pool, schema bootstrap (`CREATE TABLE IF NOT EXISTS`),
 * and all typed CRUD for users, sessions, projects, goals, and daily_log.
 *
 * Every query is scoped by `user_id` so multiple accounts share one database
 * safely. Demo projects are seeded only for new signups when SEED_DEMO_DATA
 * allows it (local by default, off on Railway).
 */
import pg from "pg";
import crypto from "node:crypto";
import { getDatabaseUrl, shouldSeedDemoData } from "./config.js";

export type ProjectType = "fast" | "passive";
export type ProjectStatus =
  | "idea"
  | "active"
  | "blocked"
  | "shipped"
  | "paid"
  | "archived";

export const PROJECT_TYPES: ProjectType[] = ["fast", "passive"];
export const PROJECT_STATUSES: ProjectStatus[] = [
  "idea",
  "active",
  "blocked",
  "shipped",
  "paid",
  "archived",
];

export interface User {
  id: number;
  email: string;
  password_hash?: string;
  name: string | null;
  telegram_chat_id: string | null;
  daily_time: string;
  checkin_time: string;
  timezone: string;
  stall_days: number;
  last_daily_nudge_date: string | null;
  last_checkin_nudge_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: number;
  user_id: number;
  name: string;
  type: ProjectType;
  client: string | null;
  revenue_potential: number;
  confidence: number;
  time_to_cash: number;
  effort_remaining: number;
  status: ProjectStatus;
  next_action: string | null;
  deadline: string | null;
  notes: string | null;
  last_progress_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyLogEntry {
  id: number;
  user_id: number;
  date: string;
  note: string;
  created_at: string;
}

export interface Goal {
  id: number;
  user_id: number;
  title: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export const PROJECT_EDITABLE_COLUMNS = [
  "name",
  "type",
  "client",
  "revenue_potential",
  "confidence",
  "time_to_cash",
  "effort_remaining",
  "status",
  "next_action",
  "deadline",
  "notes",
] as const;

export type ProjectEditableColumn = (typeof PROJECT_EDITABLE_COLUMNS)[number];
export type ProjectPatch = Partial<Pick<Project, ProjectEditableColumn>>;

export interface NewProject {
  name: string;
  type: ProjectType;
  client?: string | null;
  revenue_potential: number;
  confidence: number;
  time_to_cash: number;
  effort_remaining: number;
  status?: ProjectStatus;
  next_action?: string | null;
  deadline?: string | null;
  notes?: string | null;
}

export interface NewUser {
  email: string;
  password_hash: string;
  name?: string | null;
  daily_time: string;
  checkin_time: string;
  timezone: string;
  stall_days: number;
}

export interface UserSettingsPatch {
  name?: string | null;
  daily_time?: string;
  checkin_time?: string;
  timezone?: string;
  stall_days?: number;
}

let pool: pg.Pool | null = null;

// ---------------------------------------------------------------------------
// Schema — applied once at boot via initDb()
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function todayIso(): string {
  return nowIso().slice(0, 10);
}

function isoDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  telegram_chat_id TEXT UNIQUE,
  telegram_link_code TEXT,
  daily_time TEXT NOT NULL DEFAULT '07:30',
  checkin_time TEXT NOT NULL DEFAULT '20:00',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  stall_days INTEGER NOT NULL DEFAULT 4,
  last_daily_nudge_date DATE,
  last_checkin_nudge_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fast', 'passive')),
  client TEXT,
  revenue_potential INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  time_to_cash INTEGER NOT NULL,
  effort_remaining INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea','active','blocked','shipped','paid','archived')),
  next_action TEXT,
  deadline DATE,
  notes TEXT,
  last_progress_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_log_user_id ON daily_log(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
`;

function getPool(): pg.Pool {
  if (!pool) throw new Error("Database not initialized — call initDb() first.");
  return pool;
}

export async function initDb(): Promise<void> {
  if (pool) return;

  pool = new pg.Pool({
    connectionString: getDatabaseUrl(),
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
    max: 10,
  });

  await pool.query(SCHEMA);
  await pool.query(
    "UPDATE projects SET last_progress_at = created_at WHERE last_progress_at IS NULL"
  );

  const counts = await pool.query<{ projectCount: string; goalCount: string; userCount: string }>(
    `SELECT
      (SELECT COUNT(*)::text FROM projects) AS "projectCount",
      (SELECT COUNT(*)::text FROM goals) AS "goalCount",
      (SELECT COUNT(*)::text FROM users) AS "userCount"`
  );
  const row = counts.rows[0];
  console.log(
    `[db] postgres ready — ${row.userCount} user(s), ${row.projectCount} project(s), ${row.goalCount} goal(s)`
  );
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// --- Users ---

export async function createUser(user: NewUser): Promise<User> {
  const result = await getPool().query<User>(
    `INSERT INTO users
      (email, password_hash, name, daily_time, checkin_time, timezone, stall_days, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     RETURNING *`,
    [
      user.email.toLowerCase(),
      user.password_hash,
      user.name ?? null,
      user.daily_time,
      user.checkin_time,
      user.timezone,
      user.stall_days,
    ]
  );
  const created = result.rows[0];

  if (shouldSeedDemoData()) {
    await seedUserDemoData(created.id);
    console.log(`[db] inserted demo data for new user #${created.id}`);
  }

  return created;
}

export async function getUserById(id: number): Promise<User | undefined> {
  const result = await getPool().query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const result = await getPool().query<User>("SELECT * FROM users WHERE email = $1", [
    email.toLowerCase(),
  ]);
  return result.rows[0];
}

export async function getUserByTelegramChatId(chatId: string): Promise<User | undefined> {
  const result = await getPool().query<User>(
    "SELECT * FROM users WHERE telegram_chat_id = $1",
    [chatId]
  );
  return result.rows[0];
}

export async function getUsersWithTelegram(): Promise<User[]> {
  const result = await getPool().query<User>(
    "SELECT * FROM users WHERE telegram_chat_id IS NOT NULL ORDER BY id"
  );
  return result.rows;
}

export async function updateUserSettings(
  userId: number,
  patch: UserSettingsPatch
): Promise<User | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(patch.name);
  }
  if (patch.daily_time !== undefined) {
    sets.push(`daily_time = $${i++}`);
    params.push(patch.daily_time);
  }
  if (patch.checkin_time !== undefined) {
    sets.push(`checkin_time = $${i++}`);
    params.push(patch.checkin_time);
  }
  if (patch.timezone !== undefined) {
    sets.push(`timezone = $${i++}`);
    params.push(patch.timezone);
  }
  if (patch.stall_days !== undefined) {
    sets.push(`stall_days = $${i++}`);
    params.push(patch.stall_days);
  }

  if (sets.length === 0) return getUserById(userId);

  sets.push(`updated_at = NOW()`);
  params.push(userId);

  const result = await getPool().query<User>(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function setTelegramLinkCode(userId: number, code: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET telegram_link_code = $1, updated_at = NOW() WHERE id = $2",
    [code, userId]
  );
}

export async function linkTelegramByCode(
  code: string,
  chatId: string
): Promise<User | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const taken = await client.query<{ id: number }>(
      "SELECT id FROM users WHERE telegram_chat_id = $1",
      [chatId]
    );
    if (taken.rows[0]) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const result = await client.query<User>(
      `UPDATE users
       SET telegram_chat_id = $1, telegram_link_code = NULL, updated_at = NOW()
       WHERE telegram_link_code = $2
       RETURNING *`,
      [chatId, code]
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function unlinkTelegram(userId: number): Promise<void> {
  await getPool().query(
    "UPDATE users SET telegram_chat_id = NULL, telegram_link_code = NULL, updated_at = NOW() WHERE id = $1",
    [userId]
  );
}

export async function markDailyNudgeSent(userId: number, date: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET last_daily_nudge_date = $1, updated_at = NOW() WHERE id = $2",
    [date, userId]
  );
}

export async function markCheckinNudgeSent(userId: number, date: string): Promise<void> {
  await getPool().query(
    "UPDATE users SET last_checkin_nudge_date = $1, updated_at = NOW() WHERE id = $2",
    [date, userId]
  );
}

// --- Sessions ---

export async function createSession(userId: number, token: string, expiresAt: Date): Promise<void> {
  await getPool().query(
    "INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
    [userId, token, expiresAt.toISOString()]
  );
}

export async function getUserIdBySessionToken(token: string): Promise<number | undefined> {
  const result = await getPool().query<{ user_id: number }>(
    `SELECT user_id FROM sessions
     WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0]?.user_id;
}

export async function deleteSession(token: string): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE token = $1", [token]);
}

export async function deleteExpiredSessions(): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

export function generateLinkCode(): string {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

// --- Projects ---

export async function getActiveProjects(userId: number): Promise<Project[]> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 AND status = 'active' ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getAllProjects(userId: number): Promise<Project[]> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getProject(userId: number, id: number): Promise<Project | undefined> {
  const result = await getPool().query<Project>(
    "SELECT * FROM projects WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addProject(userId: number, p: NewProject): Promise<Project> {
  const ts = nowIso();
  const result = await getPool().query<Project>(
    `INSERT INTO projects
      (user_id, name, type, client, revenue_potential, confidence, time_to_cash,
       effort_remaining, status, next_action, deadline, notes,
       last_progress_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      userId,
      p.name,
      p.type,
      p.client ?? null,
      p.revenue_potential,
      p.confidence,
      p.time_to_cash,
      p.effort_remaining,
      p.status ?? "active",
      p.next_action ?? null,
      p.deadline ?? null,
      p.notes ?? null,
      ts,
      ts,
      ts,
    ]
  );
  return result.rows[0];
}

export async function setNextAction(
  userId: number,
  id: number,
  nextAction: string
): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET next_action = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3",
    [nextAction, userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setStatus(
  userId: number,
  id: number,
  status: ProjectStatus
): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET status = $1, updated_at = NOW() WHERE user_id = $2 AND id = $3",
    [status, userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function stampProgress(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET last_progress_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addDailyLog(userId: number, note: string): Promise<DailyLogEntry> {
  const date = todayIso();
  const result = await getPool().query<DailyLogEntry>(
    "INSERT INTO daily_log (user_id, date, note) VALUES ($1, $2, $3) RETURNING *",
    [userId, date, note]
  );
  return result.rows[0];
}

export async function getStalledProjects(userId: number, stallDays: number): Promise<Project[]> {
  const cutoff = new Date(Date.now() - stallDays * 86_400_000).toISOString();
  const active = await getActiveProjects(userId);
  return active
    .filter((p) => {
      if (!p.last_progress_at) return true;
      const t = new Date(p.last_progress_at).getTime();
      return Number.isNaN(t) || t < new Date(cutoff).getTime();
    })
    .sort((a, b) => {
      const ta = a.last_progress_at ? new Date(a.last_progress_at).getTime() : -Infinity;
      const tb = b.last_progress_at ? new Date(b.last_progress_at).getTime() : -Infinity;
      return ta - tb;
    });
}

export async function clearNextAction(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE projects SET next_action = NULL, updated_at = NOW() WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateProject(
  userId: number,
  id: number,
  patch: ProjectPatch
): Promise<Project | undefined> {
  const keys = (Object.keys(patch) as ProjectEditableColumn[]).filter((k) =>
    PROJECT_EDITABLE_COLUMNS.includes(k)
  );
  if (keys.length === 0) return getProject(userId, id);

  const sets = keys.map((k, idx) => `${k} = $${idx + 1}`);
  const params: unknown[] = keys.map((k) => patch[k] ?? null);
  params.push(userId, id);

  const result = await getPool().query<Project>(
    `UPDATE projects SET ${sets.join(", ")}, updated_at = NOW()
     WHERE user_id = $${keys.length + 1} AND id = $${keys.length + 2}
     RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteProject(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM projects WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Goals ---

export async function getGoals(userId: number): Promise<Goal[]> {
  const result = await getPool().query<Goal>(
    "SELECT * FROM goals WHERE user_id = $1 ORDER BY id",
    [userId]
  );
  return result.rows;
}

export async function getGoal(userId: number, id: number): Promise<Goal | undefined> {
  const result = await getPool().query<Goal>(
    "SELECT * FROM goals WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return result.rows[0];
}

export async function addGoal(
  userId: number,
  title: string,
  detail: string | null = null
): Promise<Goal> {
  const result = await getPool().query<Goal>(
    "INSERT INTO goals (user_id, title, detail) VALUES ($1, $2, $3) RETURNING *",
    [userId, title, detail]
  );
  return result.rows[0];
}

export async function updateGoal(
  userId: number,
  id: number,
  patch: { title?: string; detail?: string | null }
): Promise<Goal | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    params.push(patch.title);
  }
  if (patch.detail !== undefined) {
    sets.push(`detail = $${i++}`);
    params.push(patch.detail);
  }
  if (sets.length === 0) return getGoal(userId, id);

  sets.push("updated_at = NOW()");
  params.push(userId, id);

  const result = await getPool().query<Goal>(
    `UPDATE goals SET ${sets.join(", ")} WHERE user_id = $${i} AND id = $${i + 1} RETURNING *`,
    params
  );
  return result.rows[0];
}

export async function deleteGoal(userId: number, id: number): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM goals WHERE user_id = $1 AND id = $2",
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Demo seed for new users ---

async function seedUserDemoData(userId: number): Promise<void> {
  const ts = nowIso();
  const seeds: NewProject[] = [
    {
      name: "Joe's Pizza website",
      type: "fast",
      client: "Joe's Pizza",
      revenue_potential: 3,
      confidence: 5,
      time_to_cash: 1,
      effort_remaining: 6,
      status: "active",
      next_action: "Send the final invoice and deploy the menu page",
      deadline: isoDateInDays(2),
      notes: "Almost done — just the menu page and payment link left.",
    },
    {
      name: "Dental clinic booking tool",
      type: "fast",
      client: "BrightSmile Dental",
      revenue_potential: 5,
      confidence: 3,
      time_to_cash: 3,
      effort_remaining: 20,
      status: "active",
      next_action: "Scope the booking flow and send a fixed-price quote",
      deadline: null,
      notes: "Bigger contract, still needs a signed quote.",
    },
    {
      name: "Niche affiliate blog",
      type: "passive",
      client: null,
      revenue_potential: 4,
      confidence: 2,
      time_to_cash: 5,
      effort_remaining: 40,
      status: "active",
      next_action: "Write one 1500-word review post targeting a buyer keyword",
      deadline: null,
      notes: "Compounds slowly. Only touch with leftover time.",
    },
  ];

  for (const row of seeds) {
    await getPool().query(
      `INSERT INTO projects
        (user_id, name, type, client, revenue_potential, confidence, time_to_cash,
         effort_remaining, status, next_action, deadline, notes, last_progress_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        userId,
        row.name,
        row.type,
        row.client ?? null,
        row.revenue_potential,
        row.confidence,
        row.time_to_cash,
        row.effort_remaining,
        row.status ?? "active",
        row.next_action ?? null,
        row.deadline ?? null,
        row.notes ?? null,
        ts,
        ts,
        ts,
      ]
    );
  }

  await getPool().query(
    "INSERT INTO goals (user_id, title, detail) VALUES ($1, $2, $3)",
    [
      userId,
      "Go full-time as a dev as fast as possible",
      "Combine fast client income with passive products. Prioritize cash now; let passive compound.",
    ]
  );
}
