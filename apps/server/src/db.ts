import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

const APP_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  token text UNIQUE NOT NULL,
  player_name text NOT NULL,
  difficulty text NOT NULL,
  sandbox_db text NOT NULL,
  sandbox_user text NOT NULL,
  sandbox_password text NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  completed boolean NOT NULL DEFAULT false,
  abandoned boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS telemetry_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL,
  event_name text NOT NULL,
  stage text,
  sim_time timestamptz,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_session_idx ON telemetry_events (session_id, id);
`;

export async function migrate(): Promise<void> {
  for (const statement of APP_SQL.split(";").map((part) => part.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
}

export async function waitForDatabase(): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last;
}

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
