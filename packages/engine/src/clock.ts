/** Monday 3 June 2024, 09:00 America/Los_Angeles (PDT, UTC-7). */
export const SIM_START_ISO = "2024-06-03T16:00:00.000Z";

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function minutesBetween(earlierIso: string, laterIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 60_000;
}

export function minutesSinceStart(iso: string): number {
  return minutesBetween(SIM_START_ISO, iso);
}

/** Pacific offset in hours west of UTC, as a signed hour offset (PDT -7, PST -8). */
export function laOffsetHours(utc: Date): number {
  const y = utc.getUTCFullYear();
  const march1Dow = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  const secondSunday = 1 + ((7 - march1Dow) % 7) + 7;
  const dstStart = Date.UTC(y, 2, secondSunday, 10, 0, 0);
  const nov1Dow = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - nov1Dow) % 7);
  const dstEnd = Date.UTC(y, 10, firstSunday, 9, 0, 0);
  const t = utc.getTime();
  return t >= dstStart && t < dstEnd ? -7 : -8;
}

export function laParts(iso: string): { date: string; hour: number; minute: number } {
  const utc = new Date(iso);
  const offset = laOffsetHours(utc);
  const local = new Date(utc.getTime() + offset * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

export function formatLocalTimestamp(utc: Date): string {
  const offset = laOffsetHours(utc);
  const local = new Date(utc.getTime() + offset * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

/** Pacific wall-clock instant as a UTC Date. */
export function ptLocalToUtc(date: string, hour: number, minute: number): Date {
  const [y, mo, d] = date.split("-").map(Number);
  for (const offset of [-7, -8]) {
    const utc = new Date(Date.UTC(y, mo - 1, d, hour, minute) - offset * 3_600_000);
    if (laOffsetHours(utc) !== offset) continue;
    const parts = laParts(utc.toISOString());
    if (parts.date === date && parts.hour === hour && parts.minute === minute) return utc;
  }
  return new Date(Date.UTC(y, mo - 1, d, hour + 7, minute));
}

export function dailySlotsCrossed(
  prevIso: string,
  nextIso: string,
  hour: number,
  minute: number,
): string[] {
  const prev = Date.parse(prevIso);
  const next = Date.parse(nextIso);
  if (!(next > prev)) return [];
  const start = laParts(prevIso);
  const end = laParts(nextIso);
  const keys: string[] = [];
  const cursor = new Date(`${start.date}T00:00:00Z`);
  const endDate = new Date(`${end.date}T00:00:00Z`);
  for (let i = 0; i < 40 && cursor.getTime() <= endDate.getTime(); i++) {
    const date = cursor.toISOString().slice(0, 10);
    const slot = ptLocalToUtc(date, hour, minute).getTime();
    if (slot > prev && slot <= next) keys.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

export function advanceSimNow(
  simNow: string,
  lastRealSyncAt: number,
  lastActivityAt: number,
  nowRealMs: number,
  speed: number,
  idlePauseMs: number,
  pausedFlag: boolean,
): { simNow: string; paused: boolean } {
  if (pausedFlag) return { simNow, paused: true };
  if (nowRealMs - lastActivityAt > idlePauseMs) return { simNow, paused: true };
  const elapsedRealSec = Math.max(0, nowRealMs - lastRealSyncAt) / 1000;
  const capSimMs = 8 * 60 * 60 * 1000;
  const advanceMs = Math.min(elapsedRealSec * speed * 1000, capSimMs);
  return { simNow: new Date(Date.parse(simNow) + advanceMs).toISOString(), paused: false };
}
