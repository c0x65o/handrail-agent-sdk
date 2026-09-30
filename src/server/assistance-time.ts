export interface LocalScheduleTime {
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly utcOffset?: string | null;
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function parts(date: Date, format: Intl.DateTimeFormat) {
  const p = format.formatToParts(date);
  const get = (type: string) => p.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
/** Future wall-clock schedules. Gaps reject; folds require the selected offset.
 * No product quota or one-year horizon. Historical sub-minute zones are outside
 * this minute-resolution contract. The saved UTC instant is authoritative. */
export function resolveScheduleTime(input: LocalScheduleTime, now: number): number {
  if (!Number.isFinite(now) || !/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)
    || (input.utcOffset != null && !/^[+-](0\d|1[0-4]):[0-5]\d$/.test(input.utcOffset))) throw Error('invalid_schedule_time');
  const desired = `${input.localDate}T${input.localTime}`;
  const nominal = Date.parse(`${desired}:00Z`);
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 16) !== desired) throw Error('invalid_schedule_time');
  const format = formatter(input.timeZone);
  const candidates: number[] = [];
  // Include minute-aligned offsets, rather than assuming quarter-hour zones.
  for (let offset = -14 * 60; offset <= 14 * 60; offset++) {
    const candidate = nominal - offset * 60_000;
    if (parts(new Date(candidate), format) === desired) candidates.push(candidate);
  }
  const selected = input.utcOffset == null ? candidates
    : candidates.filter(t => t === Date.parse(`${desired}:00${input.utcOffset}`));
  if (selected.length !== 1) throw Error(candidates.length ? 'ambiguous_schedule_time' : 'nonexistent_schedule_time');
  if (selected[0] <= now) throw Error('schedule_must_be_future');
  return selected[0];
}

export function assistanceClock(now: number, timeZone: string) {
  const local = parts(new Date(now), formatter(timeZone));
  const tomorrow = new Date(`${local.slice(0, 10)}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { now: new Date(now).toISOString(), timeZone, localDate: local.slice(0, 10),
    localTime: local.slice(11), tomorrow: tomorrow.toISOString().slice(0, 10) };
}
