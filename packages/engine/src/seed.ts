import { formatLocalTimestamp } from "./clock.js";

export const SEED_VERSION = 1;
export const LATE_SOURCE_FILE = "orders_2024_06_late.csv";
export const DRIFT_SOURCE_FILE = "orders_2024_06_drift.csv";
export const NULL_SPIKE_SOURCE_FILE = "orders_2024_06_null_spike.csv";

export type SeedManifest = {
  logicalOrders: number;
  physicalOrderRows: number;
  duplicateOrderId: string;
  duplicateLatestAmount: number;
  localOnlyOrderId: string;
  localOnlyUtc: string;
  badTzOrderId: string;
  badTzCorrectUtc: string;
  refundedOrderId: string;
  refundEventOnlyOrderId: string;
  breakRefundIds: string[];
  breakNewIds: string[];
  nullOrderIdRows: number;
  nullSpikeIds: string[];
};

export type WorldSeed = {
  version: number;
  ddl: string;
  inserts: string;
  breakSql: string;
  manifest: SeedManifest;
};

type OrderRow = {
  order_id: string | null;
  customer_id: string | null;
  ordered_at: string | null;
  ordered_at_local: string | null;
  order_status: string | null;
  amount_cents: number | null;
  currency: string | null;
  source_file: string | null;
  loaded_at: string | null;
};

type EventRow = {
  event_id: string;
  order_id: string | null;
  customer_id: string | null;
  event_type: string;
  event_at: string | null;
  event_at_local: string | null;
  amount_cents: number | null;
  loaded_at: string | null;
};

function iso(d: Date): string {
  return d.toISOString();
}

function plusHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

function q(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function sourceFor(d: Date, reload: boolean): string {
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `orders_${d.getUTCFullYear()}_${month}${reload ? "_reload" : ""}.csv`;
}

function insert(table: string, cols: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const chunks: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    chunks.push(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n${slice.map((r) => `  (${r.join(", ")})`).join(",\n")};`,
    );
  }
  return chunks.join("\n");
}

const DDL = `
CREATE TABLE raw_orders (
  order_id text,
  customer_id text,
  ordered_at timestamptz,
  ordered_at_local text,
  order_status text,
  amount_cents integer,
  currency text,
  source_file text,
  loaded_at timestamptz
);
CREATE TABLE raw_events (
  event_id text,
  order_id text,
  customer_id text,
  event_type text,
  event_at timestamptz,
  event_at_local text,
  amount_cents integer,
  loaded_at timestamptz
);
CREATE INDEX raw_orders_order_id_idx ON raw_orders (order_id);
CREATE INDEX raw_events_order_id_idx ON raw_events (order_id);
CREATE INDEX raw_orders_source_file_idx ON raw_orders (source_file);
`;

export function buildWorldSeed(): WorldSeed {
  const orders: OrderRow[] = [];
  const events: EventRow[] = [];
  let eventN = 1;
  const eventId = () => `e${String(eventN++).padStart(6, "0")}`;

  const manifest: SeedManifest = {
    logicalOrders: 320,
    physicalOrderRows: 0,
    duplicateOrderId: "",
    duplicateLatestAmount: 0,
    localOnlyOrderId: "",
    localOnlyUtc: "",
    badTzOrderId: "",
    badTzCorrectUtc: "",
    refundedOrderId: "",
    refundEventOnlyOrderId: "",
    breakRefundIds: [],
    breakNewIds: [],
    nullOrderIdRows: 12,
    nullSpikeIds: [],
  };

  const breakCandidates: {
    orderId: string;
    customerId: string;
    orderedAt: string;
    local: string;
    amount: number;
  }[] = [];

  for (let i = 1; i <= 320; i++) {
    const status: "paid" | "refunded" | "cancelled" =
      i % 20 === 0 ? "cancelled" : i % 15 === 0 ? "refunded" : "paid";
    const customerId = `c${String((i % 64) + 1).padStart(3, "0")}`;
    const orderId = `o${10000 + i}`;
    const start = Date.UTC(2024, 2, 1, 18, 0, 0);
    const end = Date.UTC(2024, 5, 2, 18, 0, 0);
    const when = new Date(start + Math.floor((end - start) * ((i - 1) / 319)) + ((i * 7) % 50) * 60_000);
    const amount = 1800 + ((i * 137) % 40_000);
    const localOnly = i % 11 === 0;
    const badTz = i % 23 === 0 && !localOnly;
    const nullAmount = i % 29 === 0;
    const nullCustomer = i % 31 === 0;
    const dup = i % 17 === 0 && !badTz && !nullAmount && !nullCustomer;
    const refundEventOnly =
      status === "paid" && i % 13 === 0 && !nullAmount && !nullCustomer && !localOnly;
    const rowStatus = refundEventOnly ? "paid" : status;
    const local = formatLocalTimestamp(when);
    const utc = iso(when);
    const amountValue = nullAmount ? null : amount;
    const customerValue = nullCustomer ? null : customerId;

    const push = (row: OrderRow) => orders.push(row);

    if (badTz) {
      const badUtc = `${local.replace(" ", "T")}Z`;
      push({
        order_id: orderId,
        customer_id: customerValue,
        ordered_at: badUtc,
        ordered_at_local: local,
        order_status: rowStatus,
        amount_cents: amountValue,
        currency: "USD",
        source_file: sourceFor(when, false),
        loaded_at: iso(plusHours(when, 6)),
      });
      push({
        order_id: orderId,
        customer_id: customerValue,
        ordered_at: utc,
        ordered_at_local: local,
        order_status: rowStatus,
        amount_cents: amountValue,
        currency: "USD",
        source_file: sourceFor(when, true),
        loaded_at: iso(plusHours(when, 96)),
      });
      if (!manifest.badTzOrderId && rowStatus === "paid" && !nullAmount && !nullCustomer) {
        manifest.badTzOrderId = orderId;
        manifest.badTzCorrectUtc = utc;
      }
    } else if (localOnly) {
      push({
        order_id: orderId,
        customer_id: customerValue,
        ordered_at: null,
        ordered_at_local: local,
        order_status: rowStatus,
        amount_cents: amountValue,
        currency: "USD",
        source_file: sourceFor(when, false),
        loaded_at: iso(plusHours(when, 12)),
      });
      if (!manifest.localOnlyOrderId && rowStatus === "paid" && !nullAmount && !nullCustomer && !refundEventOnly) {
        manifest.localOnlyOrderId = orderId;
        manifest.localOnlyUtc = utc;
      }
    } else {
      push({
        order_id: orderId,
        customer_id: customerValue,
        ordered_at: utc,
        ordered_at_local: local,
        order_status: rowStatus,
        amount_cents: amountValue,
        currency: "USD",
        source_file: sourceFor(when, false),
        loaded_at: iso(plusHours(when, 12)),
      });
    }

    if (dup) {
      const latest = amount + 250;
      push({
        order_id: orderId,
        customer_id: customerValue,
        ordered_at: utc,
        ordered_at_local: local,
        order_status: rowStatus,
        amount_cents: latest,
        currency: "USD",
        source_file: sourceFor(when, true),
        loaded_at: iso(plusHours(when, 72)),
      });
      if (!manifest.duplicateOrderId && rowStatus === "paid" && !refundEventOnly) {
        manifest.duplicateOrderId = orderId;
        manifest.duplicateLatestAmount = latest;
      }
    }

    if (!manifest.refundedOrderId && status === "refunded" && !nullAmount && !nullCustomer && !badTz && !localOnly) {
      manifest.refundedOrderId = orderId;
    }
    if (!manifest.refundEventOnlyOrderId && refundEventOnly) {
      manifest.refundEventOnlyOrderId = orderId;
    }
    if (
      breakCandidates.length < 6 &&
      status === "paid" &&
      !refundEventOnly &&
      !nullAmount &&
      !nullCustomer &&
      !localOnly
    ) {
      breakCandidates.push({ orderId, customerId, orderedAt: utc, local, amount: dup ? amount + 250 : amount });
    }

    const truthAt = utc;
    const addEvent = (type: string, at: Date, amt: number | null) => {
      events.push({
        event_id: eventId(),
        order_id: orderId,
        customer_id: customerValue,
        event_type: type,
        event_at: iso(at),
        event_at_local: formatLocalTimestamp(at),
        amount_cents: amt,
        loaded_at: iso(plusHours(when, 12)),
      });
    };
    addEvent("order_placed", new Date(when.getTime() - 60_000), amountValue);
    if (rowStatus === "paid" || rowStatus === "refunded") addEvent("order_paid", when, amountValue);
    if (status === "refunded" && i % 2 === 0) addEvent("order_refunded", plusHours(when, 30), amountValue);
    if (status === "cancelled") addEvent("order_cancelled", plusHours(when, 5), amountValue);
    if (refundEventOnly) addEvent("order_refunded", plusHours(when, 20), amountValue);
    void truthAt;
  }

  for (let n = 0; n < 12; n++) {
    const when = new Date(Date.UTC(2024, 3, 4, 18, n, 0));
    orders.push({
      order_id: null,
      customer_id: n % 2 === 0 ? null : `c${String(n + 1).padStart(3, "0")}`,
      ordered_at: iso(when),
      ordered_at_local: formatLocalTimestamp(when),
      order_status: null,
      amount_cents: 1000 + n,
      currency: "USD",
      source_file: "orders_2024_04.csv",
      loaded_at: iso(plusHours(when, 8)),
    });
  }

  for (let n = 0; n < 160; n++) {
    const when = new Date(Date.UTC(2024, 2, 1, 18, 0, 0) + n * 3_600_000 * 13);
    events.push({
      event_id: eventId(),
      order_id: null,
      customer_id: `c${String((n % 64) + 1).padStart(3, "0")}`,
      event_type: "page_view",
      event_at: iso(when),
      event_at_local: formatLocalTimestamp(when),
      amount_cents: null,
      loaded_at: iso(when),
    });
  }

  manifest.breakRefundIds = breakCandidates.map((c) => c.orderId);
  const breakOrders: OrderRow[] = [];
  const breakEvents: EventRow[] = [];
  for (const c of breakCandidates) {
    breakOrders.push({
      order_id: c.orderId,
      customer_id: c.customerId,
      ordered_at: c.orderedAt,
      ordered_at_local: c.local,
      order_status: "refunded",
      amount_cents: c.amount,
      currency: "USD",
      source_file: LATE_SOURCE_FILE,
      loaded_at: "2024-06-05T17:00:00.000Z",
    });
    breakEvents.push({
      event_id: eventId(),
      order_id: c.orderId,
      customer_id: c.customerId,
      event_type: "order_refunded",
      event_at: "2024-06-05T16:40:00.000Z",
      event_at_local: formatLocalTimestamp(new Date("2024-06-05T16:40:00.000Z")),
      amount_cents: c.amount,
      loaded_at: "2024-06-05T17:00:00.000Z",
    });
  }
  for (let n = 1; n <= 12; n++) {
    const id = `o${90000 + n}`;
    const when = new Date(Date.UTC(2024, 5, 4, 16, 0, 0) + n * 3_600_000);
    const customerId = `c${String(n).padStart(3, "0")}`;
    const amount = 5000 + n * 1000;
    manifest.breakNewIds.push(id);
    breakOrders.push({
      order_id: id,
      customer_id: customerId,
      ordered_at: iso(when),
      ordered_at_local: formatLocalTimestamp(when),
      order_status: "paid",
      amount_cents: amount,
      currency: "USD",
      source_file: LATE_SOURCE_FILE,
      loaded_at: "2024-06-05T17:00:00.000Z",
    });
    breakEvents.push({
      event_id: eventId(),
      order_id: id,
      customer_id: customerId,
      event_type: "order_paid",
      event_at: iso(when),
      event_at_local: formatLocalTimestamp(when),
      amount_cents: amount,
      loaded_at: "2024-06-05T17:00:00.000Z",
    });
  }
  for (let n = 1; n <= 8; n++) {
    const id = `o${91000 + n}`;
    manifest.nullSpikeIds.push(id);
    const when = new Date(Date.UTC(2024, 5, 4, 20, n, 0));
    breakOrders.push({
      order_id: id,
      customer_id: `c${String(n).padStart(3, "0")}`,
      ordered_at: iso(when),
      ordered_at_local: formatLocalTimestamp(when),
      order_status: "paid",
      amount_cents: null,
      currency: "USD",
      source_file: LATE_SOURCE_FILE,
      loaded_at: "2024-06-05T17:00:00.000Z",
    });
  }

  manifest.physicalOrderRows = orders.length;

  const orderCols = [
    "order_id",
    "customer_id",
    "ordered_at",
    "ordered_at_local",
    "order_status",
    "amount_cents",
    "currency",
    "source_file",
    "loaded_at",
  ];
  const eventCols = [
    "event_id",
    "order_id",
    "customer_id",
    "event_type",
    "event_at",
    "event_at_local",
    "amount_cents",
    "loaded_at",
  ];
  const orderValues = (rows: OrderRow[]) =>
    rows.map((r) => [
      q(r.order_id),
      q(r.customer_id),
      q(r.ordered_at),
      q(r.ordered_at_local),
      q(r.order_status),
      q(r.amount_cents),
      q(r.currency),
      q(r.source_file),
      q(r.loaded_at),
    ]);
  const eventValues = (rows: EventRow[]) =>
    rows.map((r) => [
      q(r.event_id),
      q(r.order_id),
      q(r.customer_id),
      q(r.event_type),
      q(r.event_at),
      q(r.event_at_local),
      q(r.amount_cents),
      q(r.loaded_at),
    ]);

  return {
    version: SEED_VERSION,
    ddl: DDL.trim(),
    inserts: [insert("raw_orders", orderCols, orderValues(orders)), insert("raw_events", eventCols, eventValues(events))]
      .filter(Boolean)
      .join("\n"),
    breakSql: [
      insert("raw_orders", orderCols, orderValues(breakOrders)),
      insert("raw_events", eventCols, eventValues(breakEvents)),
    ].join("\n"),
    manifest,
  };
}

const ORDER_COLS =
  "order_id, customer_id, ordered_at, ordered_at_local, order_status, amount_cents, currency, source_file, loaded_at";

/** New nullable column plus rows a correct clean step still drops. Idempotent. */
export function schemaDriftSql(): string {
  return `
ALTER TABLE raw_orders ADD COLUMN IF NOT EXISTS promo_code text;
INSERT INTO raw_orders (${ORDER_COLS}, promo_code)
SELECT 'o92001', 'c001', '2024-06-04T18:00:00.000Z'::timestamptz, NULL, 'paid', NULL::integer, 'USD', '${DRIFT_SOURCE_FILE}', '2024-06-05T17:05:00.000Z'::timestamptz, 'WELCOME'
WHERE NOT EXISTS (SELECT 1 FROM raw_orders WHERE source_file = '${DRIFT_SOURCE_FILE}');
INSERT INTO raw_orders (${ORDER_COLS}, promo_code)
SELECT 'o92002', 'c002', '2024-06-04T18:10:00.000Z'::timestamptz, NULL, 'paid', NULL::integer, 'USD', '${DRIFT_SOURCE_FILE}', '2024-06-05T17:05:00.000Z'::timestamptz, 'WELCOME'
WHERE NOT EXISTS (SELECT 1 FROM raw_orders WHERE order_id = 'o92002' AND source_file = '${DRIFT_SOURCE_FILE}');
`.trim();
}

/** Extra null amounts, separate from the late file. A correct clean step excludes them. */
export function nullSpikeSql(): string {
  const values = [1, 2, 3, 4, 5, 6]
    .map(
      (n) =>
        `('o93${String(n).padStart(3, "0")}', 'c${String(n).padStart(3, "0")}', '2024-06-04T21:0${n}:00.000Z'::timestamptz, NULL, 'paid', NULL::integer, 'USD', '${NULL_SPIKE_SOURCE_FILE}', '2024-06-05T17:06:00.000Z'::timestamptz)`,
    )
    .join(",\n");
  return `
INSERT INTO raw_orders (${ORDER_COLS})
SELECT * FROM (VALUES
${values}
) AS spike(${ORDER_COLS})
WHERE NOT EXISTS (SELECT 1 FROM raw_orders WHERE source_file = '${NULL_SPIKE_SOURCE_FILE}');
`.trim();
}

let cached: WorldSeed | null = null;
export function getWorldSeed(): WorldSeed {
  if (!cached) cached = buildWorldSeed();
  return cached;
}
