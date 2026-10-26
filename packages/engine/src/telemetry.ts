import type { TelemetryEventName } from "./types.js";

export const TELEMETRY_EVENTS: TelemetryEventName[] = [
  "project_started",
  "onboarding_complete",
  "ticket_opened",
  "query_run",
  "error_returned",
  "chat_message_sent",
  "clarifying_question_asked",
  "clarifying_question",
  "schema_explored",
  "suggestion_made",
  "improvement_beyond_scope",
  "escalation",
  "priority_decision",
  "deadline_event",
  "pressure_window_start",
  "pressure_window_end",
  "message_sent",
  "integrity_signal",
  "consent_recorded",
  "pipeline_step_created",
  "pipeline_run",
  "break_detected",
  "break_fixed",
  "deliverable_submitted",
  "verdict",
  "standing_change",
  "handoff_submitted",
  "project_completed",
  "next_project_chosen",
  "session_abandoned",
  "kt_joined",
  "kt_topic_covered",
  "kt_question",
  "kt_completed",
];

/** Consequences change how people talk to you. They never close a tool. */
export function isAccessLocked(_standing: number): boolean {
  return false;
}
