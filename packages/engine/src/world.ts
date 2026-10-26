import type { Difficulty, PersonaId } from "./types.js";

export type Persona = {
  id: PersonaId;
  name: string;
  role: string;
  kind: "manager" | "teammate" | "consumer" | "stakeholder";
  pronouns: string;
  voice: string;
  channel: string;
};

export const CAST: Persona[] = [
  {
    id: "priya",
    name: "Priya Shah",
    role: "Data lead",
    kind: "manager",
    pronouns: "she/her",
    voice:
      "Direct, warm, short sentences. You set definitions and deadlines. You never write SQL or a step-by-step transform.",
    channel: "dm:priya",
  },
  {
    id: "jonah",
    name: "Jonah Ellis",
    role: "Source owner, landing zone",
    kind: "teammate",
    pronouns: "he/him",
    voice:
      "Precise about files, loads, and columns. You point at the ERD. You never write the player's transform.",
    channel: "dm:jonah",
  },
  {
    id: "sam",
    name: "Sam Okonkwo",
    role: "ML engineer, churn",
    kind: "consumer",
    pronouns: "he/him",
    voice:
      "You consume churn_features. You care that the table is fresh and stable. You do not know how orders are cleaned and you will not invent the SQL.",
    channel: "dm:sam",
  },
  {
    id: "riley",
    name: "Riley Chen",
    role: "Growth analytics",
    kind: "stakeholder",
    pronouns: "they/them",
    voice:
      "You run the exec revenue dashboard off daily_revenue. You ask whether the number moved and why. You are not a SQL person.",
    channel: "dm:riley",
  },
];

export const CAST_BY_ID: Record<PersonaId, Persona> = Object.fromEntries(
  CAST.map((p) => [p.id, p]),
) as Record<PersonaId, Persona>;

export type SchemaTable = { table: string; columns: string[] };

export const SCHEMA_CATALOG: SchemaTable[] = [
  {
    table: "raw_orders",
    columns: [
      "order_id",
      "customer_id",
      "ordered_at",
      "ordered_at_local",
      "order_status",
      "amount_cents",
      "currency",
      "source_file",
      "loaded_at",
      "promo_code",
    ],
  },
  {
    table: "raw_events",
    columns: [
      "event_id",
      "order_id",
      "customer_id",
      "event_type",
      "event_at",
      "event_at_local",
      "amount_cents",
      "loaded_at",
    ],
  },
  {
    table: "clean_orders",
    columns: ["order_id", "customer_id", "ordered_at", "amount_cents"],
  },
  {
    table: "churn_features",
    columns: ["customer_id", "as_of_date", "orders_30d", "revenue_30d", "days_since_last_order"],
  },
  {
    table: "daily_revenue",
    columns: ["revenue_date", "order_count", "gross_revenue", "aov"],
  },
  {
    table: "repeat_cohorts",
    columns: ["customer_id", "order_count", "repeat_buyer"],
  },
];

export const SCHEMA_IDENTIFIERS: string[] = SCHEMA_CATALOG.flatMap((t) => [t.table, ...t.columns]);

export const RELATIONSHIPS = [
  {
    from: "raw_events.order_id",
    to: "raw_orders.order_id",
    kind: "logical" as const,
    note: "Not enforced. Landing files repeat ids and sometimes omit them.",
  },
  {
    from: "clean_orders.customer_id",
    to: "churn_features.customer_id",
    kind: "logical" as const,
    note: "One feature row per customer in clean_orders.",
  },
  {
    from: "clean_orders.ordered_at",
    to: "daily_revenue.revenue_date",
    kind: "logical" as const,
    note: "revenue_date is the UTC date of ordered_at.",
  },
];

export const COMPANY = {
  id: "marlow",
  name: "Marlow",
  industry: "E-commerce",
  blurb:
    "Marlow sells home goods direct to consumers — linens, lighting, and kitchen tools. Finance stopped trusting the exec revenue chart. The churn model is waiting on a table nobody will sign.",
  timezone: "America/Los_Angeles",
  role: {
    title: "Analytics engineer",
    reportsTo: "Priya Shah",
    summary:
      "You make commerce data trustworthy enough for Sam's churn model and Riley's Thursday exec dashboard.",
  },
};

export const DIFFICULTIES: { id: Difficulty; label: string; description: string }[] = [
  {
    id: "guided",
    label: "Guided",
    description:
      "First analytics-engineer seat. Check-ins come sooner, and tickets say where to look. They still don't contain the SQL.",
  },
  {
    id: "standard",
    label: "Standard",
    description:
      "You've written SQL on a team. Shorter briefs, quieter check-ins, same contract for done.",
  },
];

export const NEXT_PROJECT = {
  id: "repeat-purchase-cohorts",
  title: "Repeat purchase cohorts",
  summary:
    "A short sprint on the same database: build repeat_cohorts from clean_orders. The wider cohort brief is not staffed past that one table.",
  status: "stub" as const,
};

export const PROJECT_META = {
  id: "trustworthy-orders" as const,
  title: "Trustworthy orders",
  epicKey: "MO",
  summary:
    "One landing zone, one clean orders table, one daily pipeline for the churn model and the revenue dashboard, and one late file that arrives after you think you're done.",
};
