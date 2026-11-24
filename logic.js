/**
 * Pure module (no DOM dependencies) for TUM campus coordinates,
 * Europe/Berlin timezone conversions, Haversine distances, and free-window calculations.
 */

export const CAMPUSES = [
  { id: 'stammgelaende', name: 'Stammgelände', short: 'Stammgelände', lat: 48.14903, lon: 11.56735 },
  { id: 'garching', name: 'Garching Forschungszentrum', short: 'Garching', lat: 48.26538, lon: 11.67152 },
  { id: 'wzw', name: 'Weihenstephan (Freising)', short: 'Weihenstephan', lat: 48.39774, lon: 11.72280 },
  { id: 'olympiapark', name: 'Olympiapark', short: 'Olympiapark', lat: 48.17897, lon: 11.54605 },
  { id: 'taufkirchen-ottobrunn', name: 'Taufkirchen / Ottobrunn', short: 'Ottobrunn', lat: 48.05453, lon: 11.65308 },
  { id: 'mri', name: 'Klinikum rechts der Isar', short: 'Klinikum (MRI)', lat: 48.13744, lon: 11.60185 },
  { id: 'cs', name: 'Campus Straubing', short: 'Straubing', lat: 48.88454, lon: 12.58401 },
  { id: 'heilbronn', name: 'Campus Heilbronn', short: 'Heilbronn', lat: 49.14810, lon: 9.21646 },
];

export const USAGES_META = {
  Hörsaal: { label: 'Lecture hall', de: 'Hörsaal', defaultOn: true },
  Seminarraum: { label: 'Seminar room', de: 'Seminarraum', defaultOn: true },
  Übungsraum: { label: 'Exercise room', de: 'Übungsraum', defaultOn: true },
  Unterrichtsraum: { label: 'Classroom', de: 'Unterrichtsraum', defaultOn: true },
  Studentenarbeitsraum: { label: 'Study room', de: 'Studentenarbeitsraum', defaultOn: true },
  Lesesaal: { label: 'Reading room', de: 'Lesesaal', defaultOn: true },
  Zeichensaal: { label: 'Drawing room', de: 'Zeichensaal', defaultOn: true },
  'EDV-Raum': { label: 'Computer lab', de: 'EDV-Raum', defaultOn: true },
};

const BERLIN_TZ = 'Europe/Berlin';

const berlinPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BERLIN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const berlinHmFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BERLIN_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const berlinDateLabelFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BERLIN_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Great-circle distance in meters between two coordinates (Haversine formula).
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Extracts Munich (Europe/Berlin) local date/time parts from a UTC timestamp (ms).
 */
export function getBerlinDateTimeParts(utcMs) {
  const parts = berlinPartsFormatter.formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateStr: `${map.year}-${map.month}-${map.day}`,
    timeStr: `${pad2(hour)}:${pad2(minute)}`,
  };
}

/**
 * Converts a date ('YYYY-MM-DD') and time ('HH:MM') in Europe/Berlin to a UTC timestamp (ms).
 * Uses iterative offset correction to handle CET (+01:00), CEST (+02:00), and DST transitions.
 */
export function berlinLocalToUtcMs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const intendedAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);

  let guess = intendedAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = getBerlinDateTimeParts(guess);
    const actualAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const diff = intendedAsUtc - actualAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function getBerlinDayBoundsUtc(dateStr) {
  const startMs = berlinLocalToUtcMs(dateStr, '00:00');
  const endMs = berlinLocalToUtcMs(dateStr, '23:59') + 59999;
  const barStartMs = berlinLocalToUtcMs(dateStr, '07:30');
  const barEndMs = berlinLocalToUtcMs(dateStr, '21:30');
  const timelineMinStartMs = berlinLocalToUtcMs(dateStr, '07:00');
  const timelineMinEndMs = berlinLocalToUtcMs(dateStr, '22:00');
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    barStartMs,
    barEndMs,
    timelineMinStartMs,
    timelineMinEndMs,
  };
}

export function formatUtcToBerlinHM(utcMs) {
  return berlinHmFormatter.format(new Date(utcMs));
}

export function formatUtcToBerlinDateLabel(utcMs) {
  return berlinDateLabelFormatter.format(new Date(utcMs));
}

export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function pickEventTitle(ev) {
  const en = (ev.title_en || '').trim();
  const de = (ev.title_de || '').trim();
  return en || de || 'Reserved event';
}

export function translateEntryType(entryType) {
  switch (entryType) {
    case 'lecture':
      return 'Lecture';
    case 'exercise':
      return 'Exercise';
    case 'exam':
      return 'Exam';
    case 'barred':
      return 'Blocked';
    default:
      return 'Booking';
  }
}

/**
 * Merges overlapping or contiguous busy intervals within [dayStartMs, dayEndMs].
 * Deduplicates identical events (e.g. multiple study programs sharing the same lecture).
 */
export function mergeBusyIntervals(events, dayStartMs, dayEndMs) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const parsed = [];
  const seenKeys = new Set();

  for (const ev of events) {
    const rawStart = Date.parse(ev?.start_at);
    const rawEnd = Date.parse(ev?.end_at);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= rawStart) {
      continue;
    }
    const startMs = Math.max(dayStartMs, rawStart);
    const endMs = Math.min(dayEndMs, rawEnd);
    if (endMs <= startMs) continue;

    const title = pickEventTitle(ev);
    const dedupKey = `${startMs}|${endMs}|${title}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    parsed.push({
      startMs,
      endMs,
      event: {
        id: ev.id,
        title,
        stp_type: ev.stp_type || null,
        entry_type: ev.entry_type || 'other',
        startMs,
        endMs,
      },
    });
  }

  parsed.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged = [];
  for (const item of parsed) {
    const last = merged[merged.length - 1];
    if (!last || item.startMs > last.endMs) {
      merged.push({
        startMs: item.startMs,
        endMs: item.endMs,
        events: [item.event],
      });
    } else {
      if (item.endMs > last.endMs) last.endMs = item.endMs;
      last.events.push(item.event);
    }
  }
  return merged;
}

/**
 * Computes availability status, free/busy windows, and full-day timeline.
 */
export function computeRoomAvailability(events, targetUtcMs, dayStartMs, dayEndMs) {
  const mergedBusy = mergeBusyIntervals(events, dayStartMs, dayEndMs);

  let currentIdx = -1;
  let nextIdx = -1;
  let prevIdx = -1;

  for (let i = 0; i < mergedBusy.length; i += 1) {
    const iv = mergedBusy[i];
    if (targetUtcMs >= iv.startMs && targetUtcMs < iv.endMs) {
      currentIdx = i;
      break;
    }
    if (iv.endMs <= targetUtcMs) {
      prevIdx = i;
    } else if (iv.startMs > targetUtcMs && nextIdx === -1) {
      nextIdx = i;
    }
  }

  const isFreeNow = currentIdx === -1;
  let status = 'free';
  let freeSinceMs = null;
  let freeUntilMs = null;
  let freeRemainingMin = null;
  let busyUntilMs = null;
  let freeInMin = 0;
  let afterFreeUntilMs = null;
  let afterFreeDurationMin = null;
  let currentEvent = null;
  let nextEvent = null;

  if (isFreeNow) {
    freeSinceMs = prevIdx >= 0 ? mergedBusy[prevIdx].endMs : null;
    if (nextIdx >= 0) {
      freeUntilMs = mergedBusy[nextIdx].startMs;
      freeRemainingMin = Math.max(0, Math.round((freeUntilMs - targetUtcMs) / 60000));
      nextEvent = mergedBusy[nextIdx].events[0] || null;
    }
  } else {
    const cur = mergedBusy[currentIdx];
    busyUntilMs = cur.endMs;
    freeInMin = Math.max(0, Math.round((busyUntilMs - targetUtcMs) / 60000));
    status = freeInMin <= 30 ? 'freeing_soon' : 'busy';
    currentEvent = cur.events[0] || null;

    const following = mergedBusy[currentIdx + 1] || null;
    if (following) {
      afterFreeUntilMs = following.startMs;
      afterFreeDurationMin = Math.max(0, Math.round((afterFreeUntilMs - busyUntilMs) / 60000));
      nextEvent = following.events[0] || null;
    }
  }

  const daySpanMs = dayEndMs - dayStartMs;
  const approx07 = dayStartMs + 7 * 3600 * 1000;
  const approx22 = Math.min(dayEndMs, dayStartMs + 22 * 3600 * 1000);
  const windowStart =
    mergedBusy.length > 0 ? Math.min(approx07, mergedBusy[0].startMs) : approx07;
  const windowEnd =
    mergedBusy.length > 0
      ? Math.max(approx22, mergedBusy[mergedBusy.length - 1].endMs)
      : approx22;
  const safeStart = daySpanMs > 0 ? windowStart : dayStartMs;
  const safeEnd = daySpanMs > 0 ? windowEnd : dayEndMs;

  const timeline = [];
  let cursor = safeStart;
  for (const busy of mergedBusy) {
    if (busy.startMs > cursor) {
      timeline.push({
        kind: 'free',
        startMs: cursor,
        endMs: busy.startMs,
        durationMin: Math.round((busy.startMs - cursor) / 60000),
      });
    }
    timeline.push({
      kind: 'busy',
      startMs: busy.startMs,
      endMs: busy.endMs,
      durationMin: Math.round((busy.endMs - busy.startMs) / 60000),
      events: busy.events,
    });
    if (busy.endMs > cursor) cursor = busy.endMs;
  }
  if (safeEnd > cursor) {
    timeline.push({
      kind: 'free',
      startMs: cursor,
      endMs: safeEnd,
      durationMin: Math.round((safeEnd - cursor) / 60000),
    });
  }

  return {
    status,
    isFreeNow,
    freeSinceMs,
    freeUntilMs,
    freeRemainingMin,
    busyUntilMs,
    freeInMin,
    afterFreeUntilMs,
    afterFreeDurationMin,
    currentEvent,
    nextEvent,
    mergedBusy,
    timeline,
    eventsCount: mergedBusy.length,
  };
}

/**
 * Checks whether the computed room availability matches the minimum free duration filter.
 */
export function matchesMinDuration(avail, minMinutes, includeFreeingSoon = false) {
  if (!avail) return false;
  if (avail.status === 'free') {
    if (!minMinutes || minMinutes <= 0) return true;
    return avail.freeRemainingMin === null || avail.freeRemainingMin >= minMinutes;
  }
  if (includeFreeingSoon && avail.status === 'freeing_soon') {
    if (!minMinutes || minMinutes <= 0) return true;
    return avail.afterFreeDurationMin === null || avail.afterFreeDurationMin >= minMinutes;
  }
  return false;
}
