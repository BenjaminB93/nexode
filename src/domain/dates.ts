// Jours calendaires en 'YYYY-MM-DD' ; instants en ISO 8601 UTC.

const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timezone: string): Intl.DateTimeFormat {
  let f = formats.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formats.set(timezone, f);
  }
  return f;
}

// Jour local d'un instant dans un fuseau IANA (ex. 'Europe/Paris').
export function localDate(instant: string | Date, timezone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new RangeError(`Instant invalide : ${String(instant)}`);
  const parts = formatFor(timezone).formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function todayIn(timezone: string, now: Date): string {
  return localDate(now, timezone);
}

function dayToUtcMs(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new RangeError(`Jour invalide : ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Nombre de jours calendaires de a à b (négatif si b est avant a).
export function daysBetween(a: string, b: string): number {
  return Math.round((dayToUtcMs(b) - dayToUtcMs(a)) / DAY_MS);
}
