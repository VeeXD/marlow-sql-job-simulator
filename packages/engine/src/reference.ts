/**
 * Reference transforms used only by the grader, the G2 scratch check, the probe
 * harness, and the end-to-end test (which plays the analyst). Persona prompts
 * must not import this module.
 */
export const REFERENCE_CANARY = "CANARY_DO_NOT_LEAK_9f3a";

export const CLEAN_SELECT = `
SELECT
  l.order_id,
  l.customer_id,
  l.ordered_at,
  l.amount_cents::bigint AS amount_cents
FROM (
  SELECT
    btrim(order_id) AS order_id,
    btrim(customer_id) AS customer_id,
    COALESCE(
      ordered_at,
      ordered_at_local::timestamp AT TIME ZONE 'America/Los_Angeles'
    ) AS ordered_at,
    amount_cents,
    lower(btrim(order_status)) AS order_status,
    loaded_at,
    ROW_NUMBER() OVER (
      PARTITION BY btrim(order_id)
      ORDER BY loaded_at DESC NULLS LAST
    ) AS rn
  FROM raw_orders
  WHERE order_id IS NOT NULL AND btrim(order_id) <> ''
) l
WHERE l.rn = 1
  AND l.customer_id IS NOT NULL AND btrim(l.customer_id) <> ''
  AND l.amount_cents IS NOT NULL
  AND l.ordered_at IS NOT NULL
  AND l.order_status NOT IN ('refunded', 'cancelled')
  AND l.order_id NOT IN (
    SELECT DISTINCT btrim(order_id)
    FROM raw_events
    WHERE lower(event_type) IN ('order_refunded', 'order_cancelled')
      AND order_id IS NOT NULL
  )
`.trim();

export const CHURN_SELECT_FROM = (source: string) => `
SELECT
  c.customer_id,
  b.as_of_date,
  COUNT(*) FILTER (
    WHERE (c.ordered_at AT TIME ZONE 'UTC')::date BETWEEN b.as_of_date - 29 AND b.as_of_date
  )::int AS orders_30d,
  COALESCE(SUM(c.amount_cents) FILTER (
    WHERE (c.ordered_at AT TIME ZONE 'UTC')::date BETWEEN b.as_of_date - 29 AND b.as_of_date
  ), 0)::bigint AS revenue_30d,
  (b.as_of_date - MAX((c.ordered_at AT TIME ZONE 'UTC')::date))::int AS days_since_last_order
FROM ${source} c
CROSS JOIN (
  SELECT MAX((ordered_at AT TIME ZONE 'UTC')::date) AS as_of_date FROM ${source}
) b
GROUP BY c.customer_id, b.as_of_date
`.trim();

export const REVENUE_SELECT_FROM = (source: string) => `
SELECT
  (ordered_at AT TIME ZONE 'UTC')::date AS revenue_date,
  COUNT(*)::int AS order_count,
  SUM(amount_cents)::bigint AS gross_revenue,
  (SUM(amount_cents)::numeric / COUNT(*)) AS aov
FROM ${source}
GROUP BY 1
`.trim();

export const COHORT_SELECT = `
SELECT
  customer_id,
  COUNT(*)::int AS order_count,
  (COUNT(*) >= 2) AS repeat_buyer
FROM clean_orders
GROUP BY customer_id
`.trim();

export const REFERENCE_PLAN = `
Deduplicate with ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY loaded_at DESC).
Exclude order_refunded and order_cancelled from raw_events.
Exclude order_status refunded and cancelled.
Convert ordered_at_local with AT TIME ZONE 'America/Los_Angeles' when ordered_at is null.
Drop null order_id, customer_id, amount_cents.
Build churn_features with a 30-day window ending on as_of_date and daily_revenue grouped by UTC date.
`.trim();

function canary(sql: string): string {
  return `-- ${REFERENCE_CANARY}\n${sql}`;
}

export function referencePipelineSteps(): { name: string; sql: string }[] {
  return [
    {
      name: "Rebuild clean_orders",
      sql: canary(`
DROP TABLE IF EXISTS clean_orders;
CREATE TABLE clean_orders (
  order_id text PRIMARY KEY,
  customer_id text NOT NULL,
  ordered_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL
);
INSERT INTO clean_orders (order_id, customer_id, ordered_at, amount_cents)
${CLEAN_SELECT};
`.trim()),
    },
    {
      name: "Rebuild churn_features",
      sql: canary(`
DROP TABLE IF EXISTS churn_features;
CREATE TABLE churn_features (
  customer_id text PRIMARY KEY,
  as_of_date date NOT NULL,
  orders_30d integer NOT NULL,
  revenue_30d bigint NOT NULL,
  days_since_last_order integer NOT NULL
);
INSERT INTO churn_features (customer_id, as_of_date, orders_30d, revenue_30d, days_since_last_order)
${CHURN_SELECT_FROM("clean_orders")};
`.trim()),
    },
    {
      name: "Rebuild daily_revenue",
      sql: canary(`
DROP TABLE IF EXISTS daily_revenue;
CREATE TABLE daily_revenue (
  revenue_date date PRIMARY KEY,
  order_count integer NOT NULL,
  gross_revenue bigint NOT NULL,
  aov numeric NOT NULL
);
INSERT INTO daily_revenue (revenue_date, order_count, gross_revenue, aov)
${REVENUE_SELECT_FROM("clean_orders")};
`.trim()),
    },
  ];
}
