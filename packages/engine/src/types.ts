export type Difficulty = "guided" | "standard";

export type PersonaId = "priya" | "jonah" | "sam" | "riley";

export type Stage =
  | "onboard"
  | "receive"
  | "investigate"
  | "pull_clean"
  | "build_pipeline"
  | "operate"
  | "communicate"
  | "judged"
  | "next";

export type TicketStatus = "ready" | "in_progress" | "done";

export type GradeCheck = {
  id: string;
  ok: boolean;
  detail: string;
};

export type GradeResult = {
  passed: boolean;
  checks: GradeCheck[];
};

export type ChatAuthor = "player" | PersonaId;

export type ChatMessage = {
  id: string;
  atSim: string;
  channel: string;
  author: ChatAuthor;
  authorName: string;
  body: string;
  intent: string;
  reaction?: string;
};

export type TicketState = {
  id: string;
  key: string;
  title: string;
  body: string;
  coachNotes: string | null;
  evaluationRule: string;
  hiddenEvaluation: string | null;
  status: TicketStatus;
  released: boolean;
  dueAt: string;
  lastVerdict: { passed: boolean; summary: string; atSim: string } | null;
};

export type PipelineStep = {
  id: string;
  name: string;
  sql: string;
};

export type Schedule = {
  cadence: "daily";
  hour: number;
  minute: number;
  timezone: "America/Los_Angeles";
};

export type StepLog = {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
};

export type PipelineRun = {
  id: string;
  atSim: string;
  ok: boolean;
  trigger: "manual" | "schedule";
  logs: StepLog[];
};

export type StandingLogEntry = {
  persona: PersonaId;
  delta: number;
  reason: string;
  simNow: string;
  standing: number;
};

export type HandoffState = {
  body: string;
  score: number;
  total: number;
  passed: boolean;
  missing: string[];
  atSim: string;
};

export type ReviewState = {
  summary: string;
  handoffScore: number;
  handoffTotal: number;
  nextProject: {
    id: string;
    title: string;
    summary: string;
    status: "stub";
  };
};

export type ConsentState = {
  practiceTelemetry: boolean;
  integritySignals: boolean;
  retentionDays: number;
  notice: string;
};

export type BreakKind = "late_data" | "schema_drift" | "null_spike";

export type QuerySignal = {
  sqlHash: string;
  durationMs: number;
  rowsReturned: number;
  rowsScannedEstimate: number | null;
  errorClass: string | null;
  engine: "postgres";
  followsError: boolean;
  profiling: boolean;
  truncated: boolean;
  capApplied: boolean;
};

export type SessionState = {
  playerName: string;
  difficulty: Difficulty;
  projectId: "trustworthy-orders";
  stage: Stage;
  simNow: string;
  lastRealSyncAt: number;
  lastActivityAt: number;
  clockPaused: boolean;
  seq: number;
  fired: string[];
  messages: ChatMessage[];
  tickets: TicketState[];
  queriedTables: string[];
  hidden: { orderDefinitionUnlocked: boolean };
  standing: Record<PersonaId, number>;
  standingLog: StandingLogEntry[];
  statusCredits: number;
  onboarding: { welcome: boolean; walkthrough: boolean; kickoff: boolean };
  kt: { status: "scheduled" | "live" | "done"; topicsCovered: string[]; questionsAsked: number };
  kickoffAtSim: string | null;
  t3ReleasedAtSim: string | null;
  lastQueryAtSim: string | null;
  cleanOrdersPassed: boolean;
  pipelineEverSucceeded: boolean;
  pipelineSucceededAtSim: string | null;
  breakStatus: "pending" | "active" | "fixed";
  breakFixed: boolean;
  handoff: HandoffState | null;
  projectCompleted: boolean;
  nextProjectChosen: string | null;
  abandoned: boolean;
  review: ReviewState | null;
  pipeline: { steps: PipelineStep[]; schedule: Schedule; enabled: boolean };
  runs: PipelineRun[];
  scheduledRunKeys: string[];
  llmTokensUsed: number;
  consent: ConsentState;
  cohort: { active: boolean; completed: boolean };
  lastQueryFailed: boolean;
  pressureOpen: boolean;
  scenarioVersion: string;
  seed: string;
};

export type TelemetryEventName =
  | "project_started"
  | "onboarding_complete"
  | "ticket_opened"
  | "query_run"
  | "error_returned"
  | "chat_message_sent"
  | "clarifying_question_asked"
  | "clarifying_question"
  | "schema_explored"
  | "suggestion_made"
  | "improvement_beyond_scope"
  | "escalation"
  | "priority_decision"
  | "deadline_event"
  | "pressure_window_start"
  | "pressure_window_end"
  | "message_sent"
  | "integrity_signal"
  | "consent_recorded"
  | "pipeline_step_created"
  | "pipeline_run"
  | "break_detected"
  | "break_fixed"
  | "deliverable_submitted"
  | "verdict"
  | "standing_change"
  | "handoff_submitted"
  | "project_completed"
  | "next_project_chosen"
  | "session_abandoned"
  | "kt_joined"
  | "kt_topic_covered"
  | "kt_question"
  | "kt_completed";

export type SpeakEffect = {
  type: "speak";
  messageId: string;
  personaId: PersonaId;
  intent: string;
  allowedFacts: string[];
  fallback: string;
  playerMessage?: string;
  channel: string;
};

export type Effect =
  | SpeakEffect
  | { type: "telemetry"; name: TelemetryEventName; payload: Record<string, unknown> }
  | { type: "inject_break"; kind: BreakKind }
  | { type: "release_ticket"; ticketId: string };

export type DirectorEvent =
  | { type: "start" }
  | { type: "tick"; simNow: string; realNow: number; paused: boolean }
  | { type: "activity"; realNow: number }
  | { type: "player_message"; channel: string; body: string; wallLatencyMs?: number | null }
  | {
      type: "query";
      ok: boolean;
      errorMessage?: string | null;
      tables: string[];
      signal?: QuerySignal;
    }
  | { type: "open_ticket"; ticketId: string }
  | { type: "submit"; ticketId: string; grade: GradeResult }
  | { type: "save_pipeline"; steps: PipelineStep[]; schedule: Schedule }
  | {
      type: "pipeline_finished";
      ok: boolean;
      logs: StepLog[];
      trigger: "manual" | "schedule";
    }
  | { type: "submit_handoff"; body: string }
  | { type: "choose_next"; projectId: string }
  | { type: "abandon" }
  | { type: "join_kt" }
  | { type: "complete_kt" };

export type ReduceResult = {
  state: SessionState;
  effects: Effect[];
  error?: string;
};
