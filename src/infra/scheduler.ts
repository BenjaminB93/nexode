// Planificateur dans le processus : tâches quotidiennes (HH:MM dans un fuseau IANA) et horaires (minute M de chaque heure).
// Une tâche encore en cours n'est pas relancée : l'échéance est sautée. Une erreur est journalisée, la tâche reste planifiée.
// Une échéance dépassée de plus de LATE_MS au réveil (horloge avancée par NTP, processus suspendu) est sautée, jamais rattrapée :
// une tâche ne s'exécute qu'à son heure.
import { localDate } from '../domain/dates.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Réveil au moins une fois par heure : l'échéance est recalculée si l'horloge système a été corrigée (Pi sans horloge
// sauvegardée, NTP au démarrage) et aucun setTimeout ne dépasse 2^31 ms.
const MAX_WAIT_MS = HOUR_MS;
export const LATE_MS = 2 * MINUTE_MS;

export type Rule =
  | { every: 'day'; hour: number; minute: number; timeZone: string }
  | { every: 'hour'; minute: number };

export type Task = (signal: AbortSignal) => unknown;

export type Timers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type Scheduler = {
  // Chaque jour à time ('HH:MM') dans timeZone.
  daily(name: string, time: string, task: Task, timeZone?: string): void;
  // Chaque heure à la minute donnée (heure UTC ; identique en heure locale pour les fuseaux à décalage entier, dont Paris).
  // Une échéance est manquée si le processus est arrêté à ce moment, et peut être répétée si un redémarrage s'accompagne d'une
  // correction d'horloge de moins de LATE_MS : une tâche qui envoie quelque chose garde trace de ses envois.
  hourly(name: string, minute: number, task: Task): void;
  // Plus aucune exécution ; les tâches en cours reçoivent l'abandon (signal) et la promesse attend leur fin.
  stop(): Promise<void>;
};

export type SchedulerDeps = { timers?: Timers; log?: (message: string) => void; error?: (message: string) => void };

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const wallFormats = new Map<string, Intl.DateTimeFormat>();

// Heure murale d'un instant dans un fuseau, relue comme si elle était UTC (ms).
function wallMs(t: number, timeZone: string): number {
  let f = wallFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    wallFormats.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

// Instant d'une heure murale (exprimée en ms « comme UTC ») dans un fuseau.
// Heure qui existe deux fois (passage à l'heure d'hiver) : la première. Heure qui n'existe pas (passage à l'heure d'été) :
// décalée de la durée du saut (02:30 → 03:30 à Paris).
export function zonedToUtc(wall: number, timeZone: string): number {
  const before = wall - wallMs(wall - DAY_MS, timeZone) + (wall - DAY_MS);
  const after = wall - wallMs(wall + DAY_MS, timeZone) + (wall + DAY_MS);
  const valid = [before, after].filter((t) => wallMs(t, timeZone) === wall);
  return valid.length ? Math.min(...valid) : before;
}

// Prochaine échéance strictement après afterMs.
export function nextRun(rule: Rule, afterMs: number): number {
  if (rule.every === 'hour') {
    const t = Math.floor(afterMs / HOUR_MS) * HOUR_MS + rule.minute * MINUTE_MS;
    return t > afterMs ? t : t + HOUR_MS;
  }
  const [y, m, d] = localDate(new Date(afterMs), rule.timeZone).split('-').map(Number) as [number, number, number];
  for (let i = 0; ; i++) {
    const t = zonedToUtc(Date.UTC(y, m - 1, d + i, rule.hour, rule.minute), rule.timeZone);
    if (t > afterMs) return t;
  }
}

function parseTime(time: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new RangeError(`Heure invalide (HH:MM attendu) : ${time}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function createScheduler({ timers = systemTimers, log = console.log, error = console.error }: SchedulerDeps = {}): Scheduler {
  const handles = new Set<unknown>();
  const running = new Set<Promise<void>>();
  const abort = new AbortController();

  function add(name: string, rule: Rule, task: Task): void {
    if (abort.signal.aborted) throw new Error('Planificateur arrêté');
    let due = nextRun(rule, timers.now()); // lève RangeError si le fuseau est inconnu
    let current: Promise<void> | null = null;
    let handle: unknown;

    const arm = () => {
      handle = timers.setTimeout(wake, Math.max(0, Math.min(due - timers.now(), MAX_WAIT_MS)));
      handles.add(handle);
    };

    function wake(): void {
      handles.delete(handle);
      if (abort.signal.aborted) return;
      const now = timers.now();
      if (now < due) {
        due = nextRun(rule, now);
        return arm();
      }
      const late = now - due > LATE_MS;
      due = nextRun(rule, now);
      if (late) log(`tâche « ${name} » : échéance manquée (horloge corrigée ou processus suspendu), prochaine le ${new Date(due).toISOString()}`);
      else if (current) log(`tâche « ${name} » encore en cours : échéance sautée`);
      else run();
      arm();
    }

    function run(): void {
      const p = (async () => {
        try {
          await task(abort.signal);
        } catch (err) {
          error(`tâche « ${name} » en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
      })().finally(() => {
        current = null;
        running.delete(p);
      });
      current = p;
      running.add(p);
    }

    arm();
  }

  return {
    daily(name, time, task, timeZone = 'Europe/Paris') {
      add(name, { every: 'day', ...parseTime(time), timeZone }, task);
    },
    hourly(name, minute, task) {
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError(`Minute invalide : ${minute}`);
      add(name, { every: 'hour', minute }, task);
    },
    async stop() {
      abort.abort();
      for (const h of handles) timers.clearTimeout(h);
      handles.clear();
      await Promise.all(running);
    },
  };
}
