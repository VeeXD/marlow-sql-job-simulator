export type HandoffGrade = {
  score: number;
  total: number;
  passed: boolean;
  missing: string[];
  checks: { id: string; label: string; ok: boolean }[];
};

const CHECKS: { id: string; label: string; test: (t: string) => boolean }[] = [
  {
    id: "table",
    label: "names the clean orders table",
    test: (t) => t.includes("clean_orders") || t.includes("clean orders"),
  },
  {
    id: "dedupe",
    label: "mentions duplicates or the latest load",
    test: (t) => /dup|dedup|latest load|reload/.test(t),
  },
  {
    id: "refund",
    label: "mentions refunds or cancellations",
    test: (t) => /refund|cancel/.test(t),
  },
  {
    id: "utc",
    label: "mentions UTC or the Pacific clock",
    test: (t) => /utc|time ?zone|los angeles|pacific/.test(t),
  },
  {
    id: "pipeline",
    label: "mentions the daily pipeline or the consumer tables",
    test: (t) => /pipeline|daily|schedule|churn_features|daily_revenue/.test(t),
  },
  {
    id: "break",
    label: "mentions the late file or the break",
    test: (t) => /late|break|file drop|null spike|drift/.test(t),
  },
  {
    id: "length",
    label: "is long enough to brief the next person (80 characters)",
    test: (t) => t.trim().length >= 80,
  },
];

export function gradeHandoff(body: string): HandoffGrade {
  const t = body.toLowerCase();
  const checks = CHECKS.map((c) => ({ id: c.id, label: c.label, ok: c.test(t) }));
  const score = checks.filter((c) => c.ok).length;
  return {
    score,
    total: checks.length,
    passed: score >= 5,
    missing: checks.filter((c) => !c.ok).map((c) => c.label),
    checks,
  };
}
