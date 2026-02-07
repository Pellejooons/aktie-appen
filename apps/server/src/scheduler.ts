import type { FastifyInstance } from 'fastify';

type SchedulerState = {
  running: boolean;
  timer?: NodeJS.Timeout;
  nextRunAt?: string;
};

const state: SchedulerState = {
  running: false,
};

export function getSchedulerStatus() {
  const enabled = (process.env.SCHEDULER_ENABLED ?? '1').trim() !== '0';
  return {
    enabled,
    running: state.running,
    nextRunAt: state.nextRunAt ?? null,
    hour: Number(process.env.SCHEDULER_HOUR ?? 1),
    minute: Number(process.env.SCHEDULER_MINUTE ?? 0),
  };
}

function msUntilNextLocalTime(targetHour: number, targetMinute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(targetHour, targetMinute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function runIfNotRunning(app: FastifyInstance, fn: () => Promise<void>) {
  if (state.running) {
    app.log.warn('scheduler: skipped (already running)');
    return;
  }
  state.running = true;
  const started = Date.now();
  try {
    app.log.info('scheduler: run started');
    await fn();
    app.log.info({ durationMs: Date.now() - started }, 'scheduler: run finished');
  } catch (err: any) {
    app.log.error({ err, durationMs: Date.now() - started }, 'scheduler: run failed');
  } finally {
    state.running = false;
  }
}

export function startNightlyScheduler(app: FastifyInstance, opts?: { hour?: number; minute?: number }) {
  const enabled = (process.env.SCHEDULER_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    app.log.info('scheduler: disabled by SCHEDULER_ENABLED=0');
    return;
  }

  const hour = opts?.hour ?? Number(process.env.SCHEDULER_HOUR ?? 1);
  const minute = opts?.minute ?? Number(process.env.SCHEDULER_MINUTE ?? 0);

  const scheduleNext = () => {
    const wait = msUntilNextLocalTime(hour, minute);
  state.nextRunAt = new Date(Date.now() + wait).toISOString();
    app.log.info({ hour, minute, inMs: wait }, 'scheduler: next run scheduled');

    state.timer = setTimeout(() => {
      runIfNotRunning(app, async () => {
        // Call internal analyze route.
        await app.inject({ method: 'POST', url: '/api/analyze' });
      }).finally(() => scheduleNext());
    }, wait);
  };

  scheduleNext();
}

export function stopNightlyScheduler(app: FastifyInstance) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  state.nextRunAt = undefined;
    app.log.info('scheduler: stopped');
  }
}
