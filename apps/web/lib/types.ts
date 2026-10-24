export type PersonaId = "priya" | "jonah" | "sam" | "riley";
export type Difficulty = "guided" | "standard";

export type CastMember = { id: PersonaId; name: string; role: string; pronouns: string };

export type Company = {
  id: string;
  name: string;
  industry: string;
  blurb: string;
  timezone: string;
  role: { title: string; reportsTo: string; summary: string };
};

export type Project = { id: string; title: string; epicKey: string; summary: string };

export type World = {
  company: Company;
  difficulties: { id: Difficulty; label: string; description: string }[];
  project: Project;
  cast: CastMember[];
  nextProject: { id: string; title: string; summary: string; status: "stub" };
};

export type ChatMessage = {
  id: string;
  atSim: string;
  channel: string;
  author: "player" | PersonaId;
  authorName: string;
  body: string;
  intent: string;
};

export type Ticket = {
  id: string;
  key: string;
  title: string;
  body: string;
  coachNotes: string | null;
  evaluationRule: string;
  status: "ready" | "in_progress" | "done";
  released: boolean;
  dueAt: string;
  lastVerdict: { passed: boolean; summary: string; atSim: string } | null;
};

export type PipelineStep = { id: string; name: string; sql: string };

export type Session = {
  id: string;
  token: string;
  playerName: string;
  difficulty: Difficulty;
  stage: string;
  simNow: string;
  clockPaused: boolean;
  standing: Record<PersonaId, number>;
  standingLog: { persona: PersonaId; delta: number; reason: string; simNow: string; standing: number }[];
  messages: ChatMessage[];
  tickets: Ticket[];
  onboarding: { welcome: boolean; walkthrough: boolean; kickoff: boolean };
  breakStatus: "pending" | "active" | "fixed";
  breakFixed: boolean;
  projectCompleted: boolean;
  abandoned: boolean;
  review: {
    summary: string;
    handoffScore: number;
    handoffTotal: number;
    nextProject: { id: string; title: string; summary: string; status: "stub" };
  } | null;
  handoff: { body: string; score: number; total: number; passed: boolean; missing: string[]; atSim: string } | null;
  nextProjectChosen: string | null;
  pipeline: {
    steps: PipelineStep[];
    schedule: { cadence: "daily"; hour: number; minute: number; timezone: "America/Los_Angeles" };
    enabled: boolean;
  };
  runs: {
    id: string;
    atSim: string;
    ok: boolean;
    trigger: "manual" | "schedule";
    logs: { name: string; ok: boolean; error?: string; durationMs: number }[];
  }[];
  orderDefinitionUnlocked: boolean;
  connection: {
    engine: "postgres";
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    timezone: string;
    statementTimeoutMs: number;
    rowCap: number;
  };
  company: Company;
  project: Project;
  cast: CastMember[];
  relationships: { from: string; to: string; kind: string; note: string }[];
  llmProvider: string;
};

export type QueryResult = {
  ok: boolean;
  statements: {
    command: string | null;
    rowCount: number | null;
    fields: string[];
    rows: Record<string, unknown>[];
    truncated: boolean;
  }[];
  durationMs: number;
  error: {
    message: string;
    code?: string;
    detail?: string | null;
    hint?: string | null;
    position?: string | null;
    severity?: string | null;
  } | null;
};

export type SchemaPayload = {
  tables: { table: string; columns: { name: string; dataType: string; nullable: boolean }[] }[];
  catalog: { table: string; columns: string[] }[];
  relationships: Session["relationships"];
};

export const CHANNELS: { id: string; label: string; hint: string }[] = [
  { id: "team", label: "Team", hint: "Kickoff and the room" },
  { id: "dm:priya", label: "Priya Shah", hint: "Data lead" },
  { id: "dm:jonah", label: "Jonah Ellis", hint: "Landing zone" },
  { id: "dm:sam", label: "Sam Okonkwo", hint: "Churn model" },
  { id: "dm:riley", label: "Riley Chen", hint: "Revenue dashboard" },
];

export const STAGE_LABELS: { id: string; label: string }[] = [
  { id: "onboard", label: "Onboard" },
  { id: "receive", label: "Receive" },
  { id: "investigate", label: "Investigate" },
  { id: "pull_clean", label: "Pull & clean" },
  { id: "build_pipeline", label: "Pipeline" },
  { id: "operate", label: "Operate" },
  { id: "communicate", label: "Handoff" },
  { id: "judged", label: "Review" },
  { id: "next", label: "Next" },
];

export const PERSONA_TONE: Record<PersonaId, string> = {
  priya: "bg-[#e7f0ec] text-[#1e4a42]",
  jonah: "bg-[#e7ebf2] text-[#1b2430]",
  sam: "bg-[#f8efd8] text-[#8a5a10]",
  riley: "bg-[#f8e8e4] text-[#8f3d32]",
};
