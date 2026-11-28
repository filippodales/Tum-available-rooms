import {
  ACCESS_META,
  CAMPUSES,
  USAGES_META,
  berlinLocalToUtcMs,
  computeRoomAvailability,
  formatDistance,
  formatDuration,
  formatOperatorShort,
  formatUtcToBerlinDateLabel,
  formatUtcToBerlinHM,
  getBerlinDateTimeParts,
  getBerlinDayBoundsUtc,
  haversineMeters,
  matchesAccessFilter,
  matchesMinDuration,
  translateEntryType,
} from './logic.js';

const CALENDAR_API_URL = 'https://nav.tum.de/api/calendar';
const CACHE_TTL_MS = 15 * 60 * 1000;
const BATCH_SIZE = 10;
const MAX_CONCURRENCY = 4;
const FAV_STORAGE_KEY = 'tum_fav_rooms';
const HIDDEN_STORAGE_KEY = 'tum_hidden_rooms';

const state = {
  rooms: [],
  refLat: CAMPUSES[0].lat,
  refLon: CAMPUSES[0].lon,
  refLabel: CAMPUSES[0].short,
  activeCampusId: CAMPUSES[0].id,
  dateStr: '',
  timeStr: '',
  quickOffsetMin: 0,
  searchQuery: '',
  accessFilter: 'public', // 'public' | 'public_school' | 'all'
  statusFilter: 'free', // 'free' | 'soon' | 'all'
  minDurationMin: 0,
  selectedUsages: new Set(Object.keys(USAGES_META)),
  onlyActiveToday: false,
  onlyFavorites: false,
  favoriteIds: new Set(),
  hiddenIds: new Set(),
  loadLimit: 40,
  mobileView: 'list',
  pickingPin: false,
  calendars: new Map(), // key: `${dateStr}|${roomId}` -> { events, lastScrape, fetchedAt }
  failedIds: new Set(),
  selectedRoomId: null,
  isFetching: false,
  fetchProgress: '',
};

let fetchGeneration = 0;
let map = null;
let userMarker = null;
let roomMarkersLayer = null;

// DOM refs
const els = {
  locationBadge: document.getElementById('locationBadge'),
  gpsBtn: document.getElementById('gpsBtn'),
  themeBtn: document.getElementById('themeBtn'),
  farBanner: document.getElementById('farBanner'),
  farBannerText: document.getElementById('farBannerText'),
  dismissFarBtn: document.getElementById('dismissFarBtn'),
  campusStrip: document.getElementById('campusStrip'),
  dateInput: document.getElementById('dateInput'),
  timeInput: document.getElementById('timeInput'),
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  toggleFiltersBtn: document.getElementById('toggleFiltersBtn'),
  activeFiltersCount: document.getElementById('activeFiltersCount'),
  advancedFilters: document.getElementById('advancedFilters'),
  usageChips: document.getElementById('usageChips'),
  onlyActiveTodayCheck: document.getElementById('onlyActiveTodayCheck'),
  onlyFavoritesCheck: document.getElementById('onlyFavoritesCheck'),
  hiddenRoomsRow: document.getElementById('hiddenRoomsRow'),
  hiddenRoomsText: document.getElementById('hiddenRoomsText'),
  restoreHiddenBtn: document.getElementById('restoreHiddenBtn'),
  tabListBtn: document.getElementById('tabListBtn'),
  tabMapBtn: document.getElementById('tabMapBtn'),
  mainLayout: document.getElementById('mainLayout'),
  summaryText: document.getElementById('summaryText'),
  fetchStatusText: document.getElementById('fetchStatusText'),
  errorBanner: document.getElementById('errorBanner'),
  roomsList: document.getElementById('roomsList'),
  loadMoreWrap: document.getElementById('loadMoreWrap'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  pickPinBtn: document.getElementById('pickPinBtn'),
  mapContainer: document.getElementById('mapContainer'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  roomDrawer: document.getElementById('roomDrawer'),
  drawerKicker: document.getElementById('drawerKicker'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerSubtitle: document.getElementById('drawerSubtitle'),
  drawerBody: document.getElementById('drawerBody'),
  closeDrawerBtn: document.getElementById('closeDrawerBtn'),
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initTheme() {
  const saved = localStorage.getItem('tum_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('tum_theme', next);
}

function setDateTimeFromOffset(offsetMin) {
  state.quickOffsetMin = offsetMin;
  const targetMs = Date.now() + offsetMin * 60000;
  const parts = getBerlinDateTimeParts(targetMs);
  state.dateStr = parts.dateStr;
  state.timeStr = parts.timeStr;
  els.dateInput.value = state.dateStr;
  els.timeInput.value = state.timeStr;
  document.querySelectorAll('.quick-times .pill-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.offset) === offsetMin);
  });
}

function restoreSavedLocation() {
  try {
    const raw = localStorage.getItem('tum_last_loc');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) {
        state.refLat = parsed.lat;
        state.refLon = parsed.lon;
        state.refLabel = parsed.label || 'Saved location';
        state.activeCampusId = parsed.campusId || null;
      }
    }
  } catch {
    // ignore storage errors
  }
}

function saveLocation() {
  try {
    localStorage.setItem(
      'tum_last_loc',
      JSON.stringify({
        lat: state.refLat,
        lon: state.refLon,
        label: state.refLabel,
        campusId: state.activeCampusId,
      })
    );
  } catch {
    // ignore
  }
}

function updateLocationBadge() {
  els.locationBadge.textContent = `Location: ${state.refLabel}`;
}

function renderCampusStrip() {
  els.campusStrip.innerHTML = CAMPUSES.map(
    (c) =>
      `<button type="button" class="campus-pill ${state.activeCampusId === c.id ? 'active' : ''}" data-campus="${c.id}">${escapeHtml(c.short)}</button>`
  ).join('');
}

function renderUsageChips() {
  els.usageChips.innerHTML = Object.entries(USAGES_META)
    .map(([key, meta]) => {
      const active = state.selectedUsages.has(key);
      return `<button type="button" class="usage-chip ${active ? 'active' : ''}" data-usage="${escapeHtml(key)}">${escapeHtml(meta.label)} <span style="opacity:.65">(${escapeHtml(key)})</span></button>`;
    })
    .join('');
}

function loadIdSet(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveIdSet(storageKey, idSet) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...idSet]));
  } catch {
    // ignore storage errors
  }
}

function updateActiveFiltersBadge() {
  let count = 0;
  if (state.accessFilter !== 'public') count += 1;
  if (state.statusFilter !== 'free') count += 1;
  if (state.minDurationMin > 0) count += 1;
  if (state.selectedUsages.size < Object.keys(USAGES_META).length) count += 1;
  if (state.onlyActiveToday) count += 1;
  if (state.onlyFavorites) count += 1;
  els.activeFiltersCount.textContent = String(count);
  els.activeFiltersCount.classList.toggle('hidden', count === 0);

  const hiddenCount = state.hiddenIds.size;
  els.hiddenRoomsText.textContent = `Hidden rooms: ${hiddenCount}`;
  els.hiddenRoomsRow.classList.toggle('hidden', hiddenCount === 0);
}

function setAccessFilter(nextFilter) {
  state.accessFilter = nextFilter;
  document.querySelectorAll('#accessFilterGroup .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.access === nextFilter);
  });
  updateActiveFiltersBadge();
  refreshScheduleAndRender();
}

function selectCampus(campusId) {
  const campus = CAMPUSES.find((c) => c.id === campusId);
  if (!campus) return;
  state.refLat = campus.lat;
  state.refLon = campus.lon;
  state.refLabel = campus.short;
  state.activeCampusId = campus.id;
  state.loadLimit = 40;
  els.farBanner.classList.add('hidden');
  saveLocation();
  updateLocationBadge();
  renderCampusStrip();
  syncUserMarker();
  refreshScheduleAndRender();
}

function setCustomPosition(lat, lon, label, campusId = null) {
  state.refLat = lat;
  state.refLon = lon;
  state.refLabel = label;
  state.activeCampusId = campusId;
  state.loadLimit = 40;
  saveLocation();
  updateLocationBadge();
  renderCampusStrip();
  syncUserMarker();
  refreshScheduleAndRender();
}

function getFilteredRoomsSorted() {
  const q = state.searchQuery.trim().toLowerCase();
  const list = [];
  for (const r of state.rooms) {
    if (state.hiddenIds.has(r.id)) continue;
    if (!matchesAccessFilter(r, state.accessFilter)) continue;
    if (state.onlyFavorites && !state.favoriteIds.has(r.id)) continue;
    if (!state.selectedUsages.has(r.usage)) continue;
    if (q) {
      const hay = `${r.id} ${r.name} ${r.short_name} ${r.arch} ${r.building} ${r.campus} ${r.op_name || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const dist = haversineMeters(state.refLat, state.refLon, r.lat, r.lon);
    list.push({ ...r, dist });
  }
  list.sort((a, b) => a.dist - b.dist);
  return list;
}

function getCacheKey(dateStr, roomId) {
  return `tum_cal_v1:${dateStr}:${roomId}`;
}

function readCalendarCache(dateStr, roomId) {
  const memKey = `${dateStr}|${roomId}`;
  const now = Date.now();
  const mem = state.calendars.get(memKey);
  if (mem && now - mem.fetchedAt < CACHE_TTL_MS) {
    return mem;
  }
  try {
    const raw = sessionStorage.getItem(getCacheKey(dateStr, roomId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && now - parsed.fetchedAt < CACHE_TTL_MS) {
        state.calendars.set(memKey, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeCalendarCache(dateStr, roomId, entry) {
  const memKey = `${dateStr}|${roomId}`;
  state.calendars.set(memKey, entry);
  try {
    sessionStorage.setItem(getCacheKey(dateStr, roomId), JSON.stringify(entry));
  } catch {
    // sessionStorage quota exceeded: keep RAM cache only
  }
}

async function fetchCalendarBatchWithRecovery(ids, startIso, endIso, dateStr) {
  if (!ids.length) return;
  const resp = await fetch(CALENDAR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, start_after: startIso, end_before: endIso }),
  });

  if (resp.ok) {
    const data = await resp.json();
    const now = Date.now();
    for (const rid of ids) {
      const entry = data[rid];
      if (entry) {
        writeCalendarCache(dateStr, rid, {
          events: entry.events || [],
          lastScrape: entry.location?.last_calendar_scrape_at || null,
          fetchedAt: now,
        });
      }
    }
    return;
  }

  if (resp.status === 400 || resp.status === 404 || resp.status === 503) {
    const text = await resp.text();
    const m = text.match(/(?:Room|Requested id)\s+([^\s/]+)/);
    if (m && ids.includes(m[1])) {
      const badId = m[1];
      state.failedIds.add(badId);
      const rest = ids.filter((id) => id !== badId);
      if (rest.length) {
        await fetchCalendarBatchWithRecovery(rest, startIso, endIso, dateStr);
      }
      return;
    }
    if (ids.length === 1) {
      state.failedIds.add(ids[0]);
      return;
    }
    const mid = Math.floor(ids.length / 2);
    await fetchCalendarBatchWithRecovery(ids.slice(0, mid), startIso, endIso, dateStr);
    await fetchCalendarBatchWithRecovery(ids.slice(mid), startIso, endIso, dateStr);
    return;
  }

  throw new Error(`NavigaTUM API error (${resp.status})`);
}

async function refreshScheduleAndRender() {
  const gen = ++fetchGeneration;
  els.errorBanner.classList.add('hidden');

  const sortedRooms = getFilteredRoomsSorted();
  const candidates = sortedRooms.slice(0, state.loadLimit);

  const bounds = getBerlinDayBoundsUtc(state.dateStr);
  const missingIds = [];
  for (const r of candidates) {
    if (state.failedIds.has(r.id)) continue;
    if (!readCalendarCache(state.dateStr, r.id)) {
      missingIds.push(r.id);
    }
  }

  renderResults(sortedRooms, candidates);

  if (missingIds.length === 0) {
    state.isFetching = false;
    state.fetchProgress = '';
    els.fetchStatusText.textContent = '';
    return;
  }

  state.isFetching = true;
  const batches = [];
  for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
    batches.push(missingIds.slice(i, i + BATCH_SIZE));
  }

  let completedBatches = 0;
  let nextIdx = 0;
  els.fetchStatusText.textContent = `Checking schedules: 0/${missingIds.length} rooms...`;

  async function worker() {
    while (nextIdx < batches.length) {
      if (gen !== fetchGeneration) return;
      const idx = nextIdx++;
      const batch = batches[idx];
      await fetchCalendarBatchWithRecovery(batch, bounds.startIso, bounds.endIso, state.dateStr);
      completedBatches += 1;
      if (gen !== fetchGeneration) return;
      const doneRooms = Math.min(completedBatches * BATCH_SIZE, missingIds.length);
      els.fetchStatusText.textContent = `Checking schedules: ${doneRooms}/${missingIds.length} rooms...`;
      renderResults(sortedRooms, candidates);
    }
  }

  try {
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, () => worker());
    await Promise.all(workers);
  } catch (err) {
    if (gen === fetchGeneration) {
      els.errorBanner.textContent = `Could not refresh some schedules from NavigaTUM (${err.message}).`;
      els.errorBanner.classList.remove('hidden');
    }
  } finally {
    if (gen === fetchGeneration) {
      state.isFetching = false;
      els.fetchStatusText.textContent = '';
      renderResults(sortedRooms, candidates);
    }
  }
}

function buildMiniBarHtml(avail, bounds, targetUtcMs) {
  const span = bounds.barEndMs - bounds.barStartMs;
  if (span <= 0) return '';
  const busySegments = avail.mergedBusy
    .map((iv) => {
      const s = Math.max(bounds.barStartMs, iv.startMs);
      const e = Math.min(bounds.barEndMs, iv.endMs);
      if (e <= s) return '';
      const leftPct = ((s - bounds.barStartMs) / span) * 100;
      const widthPct = ((e - s) / span) * 100;
      return `<div class="mini-bar-busy" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></div>`;
    })
    .join('');

  let nowMarker = '';
  if (targetUtcMs >= bounds.barStartMs && targetUtcMs <= bounds.barEndMs) {
    const nowPct = ((targetUtcMs - bounds.barStartMs) / span) * 100;
    nowMarker = `<div class="mini-bar-now" style="left:${nowPct.toFixed(2)}%"></div>`;
  }

  return `
    <div class="mini-bar-wrap" aria-hidden="true">
      <div class="mini-bar">${busySegments}${nowMarker}</div>
      <div class="mini-bar-labels"><span>07:30</span><span>14:30</span><span>21:30</span></div>
    </div>
  `;
}

function describeCardStatus(avail) {
  if (avail.status === 'free') {
    const main = avail.freeUntilMs
      ? `Free until ${formatUtcToBerlinHM(avail.freeUntilMs)}`
      : 'Free rest of day';
    const dur = avail.freeRemainingMin != null ? ` (${formatDuration(avail.freeRemainingMin)})` : '';
    const sub = avail.nextEvent
      ? `Next: ${avail.nextEvent.title} at ${formatUtcToBerlinHM(avail.nextEvent.startMs)}`
      : avail.eventsCount === 0
      ? 'No bookings today on TUMonline'
      : 'No more events today';
    return { cls: 'status-free', badge: `🟢 ${main}${dur}`, sub };
  }

  if (avail.status === 'freeing_soon') {
    const untilStr = formatUtcToBerlinHM(avail.busyUntilMs);
    const afterStr = avail.afterFreeUntilMs
      ? `then free until ${formatUtcToBerlinHM(avail.afterFreeUntilMs)}`
      : 'then free rest of day';
    return {
      cls: 'status-soon',
      badge: `🟡 Free at ${untilStr} (in ${avail.freeInMin} min)`,
      sub: `${afterStr} • Ongoing: ${avail.currentEvent?.title || 'Lecture'}`,
    };
  }

  return {
    cls: 'status-busy',
    badge: `🔴 Busy until ${formatUtcToBerlinHM(avail.busyUntilMs)}`,
    sub: `Ongoing: ${avail.currentEvent?.title || 'Event'}`,
  };
}

function renderResults(sortedRooms, candidates) {
  const targetUtcMs = berlinLocalToUtcMs(state.dateStr, state.timeStr);
  const bounds = getBerlinDayBoundsUtc(state.dateStr);

  const enriched = [];
  let loadedCount = 0;
  let freeCount = 0;

  for (const room of candidates) {
    const cached = readCalendarCache(state.dateStr, room.id);
    if (!cached) {
      if (state.isFetching) {
        enriched.push({ room, loading: true });
      }
      continue;
    }
    loadedCount += 1;
    const avail = computeRoomAvailability(cached.events, targetUtcMs, bounds.startMs, bounds.endMs);
    if (avail.status === 'free') freeCount += 1;

    if (state.onlyActiveToday && avail.eventsCount === 0) continue;

    if (state.statusFilter === 'free') {
      if (!matchesMinDuration(avail, state.minDurationMin, false)) continue;
    } else if (state.statusFilter === 'soon') {
      if (!matchesMinDuration(avail, state.minDurationMin, true)) continue;
    }

    enriched.push({ room, avail, cached, loading: false });
  }

  const timeLabel = `${formatUtcToBerlinDateLabel(targetUtcMs)}, ${state.timeStr} (Munich)`;
  els.summaryText.textContent = `${freeCount} free rooms out of ${loadedCount} checked • ${timeLabel}`;

  els.loadMoreWrap.classList.toggle('hidden', candidates.length >= sortedRooms.length);
  if (candidates.length < sortedRooms.length) {
    const remaining = sortedRooms.length - candidates.length;
    const step = Math.min(30, remaining);
    els.loadMoreBtn.textContent = `Load ${step} more rooms (${candidates.length}/${sortedRooms.length})`;
  }

  if (enriched.length === 0) {
    if (state.isFetching) {
      els.roomsList.innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton-card"></div>').join('');
    } else {
      const expandBtn =
        state.accessFilter === 'public'
          ? '<button type="button" class="btn btn-secondary btn-sm" data-expand-access="public_school">Include School / Dept rooms</button>'
          : state.accessFilter === 'public_school'
          ? '<button type="button" class="btn btn-secondary btn-sm" data-expand-access="all">Include Chair rooms</button>'
          : '';
      const restoreBtn =
        state.hiddenIds.size > 0
          ? `<button type="button" class="btn btn-secondary btn-sm" data-restore-hidden="1">Restore ${state.hiddenIds.size} hidden</button>`
          : '';
      els.roomsList.innerHTML = `
        <div class="empty-state">
          <p><strong>No rooms found</strong> with the selected filters among ${candidates.length} nearby candidates.</p>
          <p>Try including School / Dept rooms, switching status to "Free + ≤30m", or changing the time.</p>
          ${expandBtn || restoreBtn ? `<div class="empty-actions">${expandBtn}${restoreBtn}</div>` : ''}
        </div>
      `;
    }
    updateRoomMarkers([]);
    return;
  }

  const cardsHtml = enriched
    .map((item) => {
      if (item.loading) return '<div class="skeleton-card"></div>';
      const { room, avail } = item;
      const st = describeCardStatus(avail);
      const usageInfo = USAGES_META[room.usage]?.label || room.usage;
      const accessMeta = ACCESS_META[room.access || 'chair'] || ACCESS_META.chair;
      const operatorShort = formatOperatorShort(room);
      const isFav = state.favoriteIds.has(room.id);
      const favIcon = isFav ? '<span class="fav-star" title="Favorite">★</span>' : '';
      const archInfo = room.arch ? ` • ${escapeHtml(room.arch)}` : '';
      const floorInfo = room.floor_code ? `<span class="floor-pill">${escapeHtml(room.floor_code)}</span>` : '';
      const eventsNote =
        avail.eventsCount > 0
          ? `${avail.eventsCount} ${avail.eventsCount === 1 ? 'event' : 'events'} today`
          : '0 bookings today';

      return `
        <article class="room-card" data-room-id="${escapeHtml(room.id)}" tabindex="0" role="button">
          <div class="card-top">
            <span class="status-badge ${st.cls}">${escapeHtml(st.badge)}</span>
            <div class="card-metrics">
              ${floorInfo}
              <span class="distance-pill">${escapeHtml(formatDistance(room.dist))}</span>
            </div>
          </div>
          <h3 class="card-title">${favIcon}${escapeHtml(room.short_name)}</h3>
          <div class="card-meta">
            <span class="usage-tag">${escapeHtml(usageInfo)}</span>
            <span class="access-tag ${accessMeta.cls}">${escapeHtml(operatorShort)}</span>
            <span>${escapeHtml(room.id)}${archInfo}</span>
            <span>• ${escapeHtml(room.building || room.campus)}</span>
            <span>• ${escapeHtml(eventsNote)}</span>
          </div>
          <div class="card-subinfo">${escapeHtml(st.sub)}</div>
          ${buildMiniBarHtml(avail, bounds, targetUtcMs)}
        </article>
      `;
    })
    .join('');

  els.roomsList.innerHTML = cardsHtml;
  updateRoomMarkers(enriched.filter((i) => !i.loading));
}

function openRoomDrawer(roomId) {
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room) return;
  state.selectedRoomId = roomId;

  const dist = haversineMeters(state.refLat, state.refLon, room.lat, room.lon);
  const targetUtcMs = berlinLocalToUtcMs(state.dateStr, state.timeStr);
  const bounds = getBerlinDayBoundsUtc(state.dateStr);
  const cached = readCalendarCache(state.dateStr, room.id);
  const avail = cached
    ? computeRoomAvailability(cached.events, targetUtcMs, bounds.startMs, bounds.endMs)
    : null;

  els.drawerKicker.textContent = `${USAGES_META[room.usage]?.label || room.usage} • ${room.campus}`;
  els.drawerTitle.textContent = room.short_name;
  els.drawerSubtitle.textContent = [
    room.id,
    room.arch ? `(${room.arch})` : '',
    room.building,
    room.floor,
    formatDistance(dist),
  ]
    .filter(Boolean)
    .join(' • ');

  let bannerHtml = '';
  let timelineHtml = '';
  let scrapeInfo = '';

  if (avail) {
    const st = describeCardStatus(avail);
    let rangeMsg = st.badge;
    if (avail.status === 'free') {
      const fromStr = avail.freeSinceMs ? `from ${formatUtcToBerlinHM(avail.freeSinceMs)}` : 'from start of day';
      const toStr = avail.freeUntilMs ? `until ${formatUtcToBerlinHM(avail.freeUntilMs)}` : 'until end of day';
      rangeMsg = `🟢 Free ${fromStr} ${toStr}${
        avail.freeRemainingMin != null ? ` (${formatDuration(avail.freeRemainingMin)} left)` : ''
      }`;
    }
    bannerHtml = `<div class="drawer-banner ${st.cls}">${escapeHtml(rangeMsg)}</div>`;

    timelineHtml = avail.timeline
      .map((slot) => {
        const isCurrent = targetUtcMs >= slot.startMs && targetUtcMs < slot.endMs;
        const range = `${formatUtcToBerlinHM(slot.startMs)} – ${formatUtcToBerlinHM(slot.endMs)}`;
        const dur = formatDuration(slot.durationMin);
        if (slot.kind === 'free') {
          return `
            <div class="tl-item tl-free ${isCurrent ? 'tl-current' : ''}">
              <div class="tl-top">
                <span>🟢 Free • ${escapeHtml(range)}</span>
                <span>${escapeHtml(dur)}</span>
              </div>
            </div>
          `;
        }
        const evLines = (slot.events || [])
          .map(
            (ev) => `
            <div>
              <span class="tl-ev-type">${escapeHtml(translateEntryType(ev.entry_type))}</span>
              <strong>${escapeHtml(ev.title)}</strong>
              ${ev.stp_type ? `<span style="color:var(--text-muted)">(${escapeHtml(ev.stp_type)})</span>` : ''}
            </div>
          `
          )
          .join('');
        return `
          <div class="tl-item tl-busy ${isCurrent ? 'tl-current' : ''}">
            <div class="tl-top">
              <span>🔴 Busy • ${escapeHtml(range)}</span>
              <span>${escapeHtml(dur)}</span>
            </div>
            <div class="tl-events">${evLines}</div>
          </div>
        `;
      })
      .join('');

    if (cached?.lastScrape) {
      const dt = new Date(cached.lastScrape);
      if (!Number.isNaN(dt.getTime())) {
        scrapeInfo = `Last TUMonline sync: ${dt.toLocaleString('en-GB', { timeZone: 'Europe/Berlin' })}.`;
      }
    }
  } else {
    bannerHtml = `<div class="drawer-banner status-soon">Schedule not loaded yet for this date.</div>`;
  }

  const navUrl = `https://nav.tum.de/room/${encodeURIComponent(room.id)}`;
  const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${room.lat},${room.lon}`;
  const isFav = state.favoriteIds.has(room.id);
  const isHidden = state.hiddenIds.has(room.id);
  const hallTip =
    room.usage === 'Hörsaal'
      ? ' Tip: Large lecture halls may have only one unlocked entrance door.'
      : '';

  els.drawerBody.innerHTML = `
    ${bannerHtml}
    <div class="drawer-personal-actions">
      <button type="button" class="btn ${isFav ? 'btn-fav-active' : 'btn-secondary'}" data-toggle-fav="${escapeHtml(room.id)}">
        ${isFav ? '★ Favorited' : '⭐ Favorite'}
      </button>
      <button type="button" class="btn btn-warn" data-toggle-hide="${escapeHtml(room.id)}">
        ${isHidden ? '🔓 Unhide room' : '🔒 Hide (PIN / Restricted)'}
      </button>
    </div>
    <div class="drawer-actions">
      <a class="action-link" href="${navUrl}" target="_blank" rel="noopener">🗺️ NavigaTUM</a>
      <a class="action-link" href="${gmapsUrl}" target="_blank" rel="noopener">🧭 Google Maps</a>
      <a class="action-link" href="${escapeHtml(room.cal_url)}" target="_blank" rel="noopener">📅 TUMonline</a>
    </div>
    <div>
      <div class="filter-label" style="margin-bottom:8px">Schedule for ${escapeHtml(formatUtcToBerlinDateLabel(targetUtcMs))}</div>
      <div class="timeline-list">${timelineHtml || '<p>No schedule data available.</p>'}</div>
    </div>
    <div class="drawer-footnote">
      ${room.op_name ? `<div><strong>Managed by:</strong> ${escapeHtml(room.op_name)} (${escapeHtml(formatOperatorShort(room))})</div>` : ''}
      ${room.address ? `<div><strong>Address:</strong> ${escapeHtml(room.address)}</div>` : ''}
      <div>${escapeHtml(scrapeInfo)} Some rooms may require keycard/PIN access or have last-minute bookings.${hallTip}</div>
    </div>
  `;

  els.drawerBackdrop.classList.remove('hidden');
  els.roomDrawer.classList.remove('hidden');
  els.drawerBackdrop.setAttribute('aria-hidden', 'false');
}

function closeRoomDrawer() {
  state.selectedRoomId = null;
  els.drawerBackdrop.classList.add('hidden');
  els.roomDrawer.classList.add('hidden');
  els.drawerBackdrop.setAttribute('aria-hidden', 'true');
}

/* Leaflet Map */
function initMap() {
  if (map || typeof window.L === 'undefined') return;
  map = window.L.map(els.mapContainer, { zoomControl: true }).setView([state.refLat, state.refLon], 16);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  roomMarkersLayer = window.L.layerGroup().addTo(map);

  userMarker = window.L.circleMarker([state.refLat, state.refLon], {
    radius: 9,
    color: '#ffffff',
    weight: 3,
    fillColor: '#0065BD',
    fillOpacity: 1,
  })
    .addTo(map)
    .bindTooltip('Your location', { direction: 'top' });

  map.on('click', (e) => {
    if (!state.pickingPin) return;
    state.pickingPin = false;
    els.pickPinBtn.classList.remove('btn-primary');
    els.pickPinBtn.classList.add('btn-secondary');
    els.pickPinBtn.textContent = '🎯 Move pin on map';
    els.mapContainer.classList.remove('picking-pin');
    setCustomPosition(e.latlng.lat, e.latlng.lng, 'Map pin');
  });
}

function syncUserMarker() {
  if (!map || !userMarker) return;
  userMarker.setLatLng([state.refLat, state.refLon]);
  map.setView([state.refLat, state.refLon], Math.max(map.getZoom(), 16));
}

function updateRoomMarkers(enrichedLoaded) {
  if (!map || !roomMarkersLayer) return;
  roomMarkersLayer.clearLayers();

  for (const item of enrichedLoaded) {
    const { room, avail } = item;
    const color =
      avail.status === 'free' ? '#16a34a' : avail.status === 'freeing_soon' ? '#d97706' : '#dc2626';
    const st = describeCardStatus(avail);

    const marker = window.L.circleMarker([room.lat, room.lon], {
      radius: 8,
      color: '#ffffff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.92,
    });

    const popupHtml = `
      <div style="min-width:180px">
        <div style="font-weight:700;margin-bottom:3px">${escapeHtml(room.short_name)}</div>
        <div style="font-size:12px;color:#475569;margin-bottom:5px">${escapeHtml(room.id)} • ${escapeHtml(formatDistance(room.dist))}</div>
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">${escapeHtml(st.badge)}</div>
        <button type="button" class="popup-detail-btn" data-room-id="${escapeHtml(room.id)}"
          style="width:100%;padding:6px 8px;border-radius:7px;border:none;background:#0065BD;color:#fff;font-weight:600;cursor:pointer">
          View full schedule
        </button>
      </div>
    `;
    marker.bindPopup(popupHtml);
    marker.addTo(roomMarkersLayer);
  }
}

function requestGpsPosition() {
  if (!navigator.geolocation) {
    els.errorBanner.textContent = 'Geolocation is not supported by this browser.';
    els.errorBanner.classList.remove('hidden');
    return;
  }
  const orig = els.gpsBtn.innerHTML;
  els.gpsBtn.disabled = true;
  els.gpsBtn.textContent = '⏳ GPS...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.gpsBtn.disabled = false;
      els.gpsBtn.innerHTML = orig;
      const { latitude, longitude } = pos.coords;

      let minDist = Infinity;
      for (const r of state.rooms) {
        const d = haversineMeters(latitude, longitude, r.lat, r.lon);
        if (d < minDist) minDist = d;
      }
      if (minDist > 5000) {
        els.farBannerText.textContent = `You seem far from TUM campuses (${formatDistance(minDist)}). Jump to a campus?`;
        els.farBanner.classList.remove('hidden');
      } else {
        els.farBanner.classList.add('hidden');
      }

      setCustomPosition(latitude, longitude, 'GPS location');
    },
    (err) => {
      els.gpsBtn.disabled = false;
      els.gpsBtn.innerHTML = orig;
      els.errorBanner.textContent = `GPS unavailable (${err.message}). Pick a campus above or place a pin on the map.`;
      els.errorBanner.classList.remove('hidden');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function setMobileView(view) {
  state.mobileView = view;
  els.mainLayout.setAttribute('data-mobile-view', view);
  els.tabListBtn.classList.toggle('active', view === 'list');
  els.tabMapBtn.classList.toggle('active', view === 'map');
  els.tabListBtn.setAttribute('aria-selected', String(view === 'list'));
  els.tabMapBtn.setAttribute('aria-selected', String(view === 'map'));
  if (view === 'map') {
    initMap();
    setTimeout(() => {
      if (map) {
        map.invalidateSize();
        syncUserMarker();
        const sorted = getFilteredRoomsSorted().slice(0, state.loadLimit);
        const targetUtcMs = berlinLocalToUtcMs(state.dateStr, state.timeStr);
        const bounds = getBerlinDayBoundsUtc(state.dateStr);
        const loaded = [];
        for (const room of sorted) {
          const cached = readCalendarCache(state.dateStr, room.id);
          if (!cached) continue;
          const avail = computeRoomAvailability(cached.events, targetUtcMs, bounds.startMs, bounds.endMs);
          loaded.push({ room, avail });
        }
        updateRoomMarkers(loaded);
      }
    }, 60);
  }
}

function bindEvents() {
  els.themeBtn.addEventListener('click', toggleTheme);
  els.gpsBtn.addEventListener('click', requestGpsPosition);

  els.farBanner.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-far-campus]');
    if (btn) selectCampus(btn.dataset.farCampus);
  });
  els.dismissFarBtn.addEventListener('click', () => els.farBanner.classList.add('hidden'));

  els.campusStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-campus]');
    if (btn) selectCampus(btn.dataset.campus);
  });

  document.querySelector('.quick-times').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-offset]');
    if (!btn) return;
    setDateTimeFromOffset(Number(btn.dataset.offset));
    refreshScheduleAndRender();
  });

  const onManualDateTime = () => {
    if (!els.dateInput.value || !els.timeInput.value) return;
    state.dateStr = els.dateInput.value;
    state.timeStr = els.timeInput.value;
    state.quickOffsetMin = null;
    document.querySelectorAll('.quick-times .pill-btn').forEach((b) => b.classList.remove('active'));
    refreshScheduleAndRender();
  };
  els.dateInput.addEventListener('change', onManualDateTime);
  els.timeInput.addEventListener('change', onManualDateTime);

  els.searchInput.addEventListener('input', () => {
    state.searchQuery = els.searchInput.value;
    els.clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
    refreshScheduleAndRender();
  });
  els.clearSearchBtn.addEventListener('click', () => {
    els.searchInput.value = '';
    state.searchQuery = '';
    els.clearSearchBtn.classList.add('hidden');
    refreshScheduleAndRender();
  });

  els.toggleFiltersBtn.addEventListener('click', () => {
    const open = els.advancedFilters.classList.toggle('hidden');
    els.toggleFiltersBtn.setAttribute('aria-expanded', String(!open));
  });

  document.getElementById('accessFilterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-access]');
    if (!btn) return;
    setAccessFilter(btn.dataset.access);
  });

  document.getElementById('statusFilterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    state.statusFilter = btn.dataset.status;
    e.currentTarget.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  document.getElementById('durationFilterGroup').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-min]');
    if (!btn) return;
    state.minDurationMin = Number(btn.dataset.min);
    e.currentTarget.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  els.usageChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-usage]');
    if (!btn) return;
    const u = btn.dataset.usage;
    if (state.selectedUsages.has(u)) {
      if (state.selectedUsages.size === 1) return;
      state.selectedUsages.delete(u);
    } else {
      state.selectedUsages.add(u);
    }
    renderUsageChips();
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  els.onlyActiveTodayCheck.addEventListener('change', () => {
    state.onlyActiveToday = els.onlyActiveTodayCheck.checked;
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  els.onlyFavoritesCheck.addEventListener('change', () => {
    state.onlyFavorites = els.onlyFavoritesCheck.checked;
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  els.restoreHiddenBtn.addEventListener('click', () => {
    state.hiddenIds.clear();
    saveIdSet(HIDDEN_STORAGE_KEY, state.hiddenIds);
    updateActiveFiltersBadge();
    refreshScheduleAndRender();
  });

  els.loadMoreBtn.addEventListener('click', () => {
    state.loadLimit += 30;
    refreshScheduleAndRender();
  });

  els.roomsList.addEventListener('click', (e) => {
    const expandBtn = e.target.closest('[data-expand-access]');
    if (expandBtn) {
      setAccessFilter(expandBtn.dataset.expandAccess);
      return;
    }
    const restoreBtn = e.target.closest('[data-restore-hidden]');
    if (restoreBtn) {
      state.hiddenIds.clear();
      saveIdSet(HIDDEN_STORAGE_KEY, state.hiddenIds);
      updateActiveFiltersBadge();
      refreshScheduleAndRender();
      return;
    }
    const card = e.target.closest('[data-room-id]');
    if (card) openRoomDrawer(card.dataset.roomId);
  });

  els.drawerBody.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-toggle-fav]');
    if (favBtn) {
      const rid = favBtn.dataset.toggleFav;
      if (state.favoriteIds.has(rid)) {
        state.favoriteIds.delete(rid);
      } else {
        state.favoriteIds.add(rid);
      }
      saveIdSet(FAV_STORAGE_KEY, state.favoriteIds);
      openRoomDrawer(rid);
      refreshScheduleAndRender();
      return;
    }
    const hideBtn = e.target.closest('[data-toggle-hide]');
    if (hideBtn) {
      const rid = hideBtn.dataset.toggleHide;
      if (state.hiddenIds.has(rid)) {
        state.hiddenIds.delete(rid);
      } else {
        state.hiddenIds.add(rid);
      }
      saveIdSet(HIDDEN_STORAGE_KEY, state.hiddenIds);
      updateActiveFiltersBadge();
      closeRoomDrawer();
      refreshScheduleAndRender();
    }
  });
  els.roomsList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('[data-room-id]');
      if (card) {
        e.preventDefault();
        openRoomDrawer(card.dataset.roomId);
      }
    }
  });

  document.body.addEventListener('click', (e) => {
    const popupBtn = e.target.closest('.popup-detail-btn');
    if (popupBtn) openRoomDrawer(popupBtn.dataset.roomId);
  });

  els.tabListBtn.addEventListener('click', () => setMobileView('list'));
  els.tabMapBtn.addEventListener('click', () => setMobileView('map'));

  els.pickPinBtn.addEventListener('click', () => {
    state.pickingPin = !state.pickingPin;
    els.pickPinBtn.classList.toggle('btn-primary', state.pickingPin);
    els.pickPinBtn.classList.toggle('btn-secondary', !state.pickingPin);
    els.pickPinBtn.textContent = state.pickingPin
      ? '👆 Tap anywhere on map...'
      : '🎯 Move pin on map';
    els.mapContainer.classList.toggle('picking-pin', state.pickingPin);
  });

  els.closeDrawerBtn.addEventListener('click', closeRoomDrawer);
  els.drawerBackdrop.addEventListener('click', closeRoomDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedRoomId) closeRoomDrawer();
  });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {
      // ignore SW registration failure in restricted contexts
    }
  }
}

async function bootstrap() {
  initTheme();
  state.favoriteIds = loadIdSet(FAV_STORAGE_KEY);
  state.hiddenIds = loadIdSet(HIDDEN_STORAGE_KEY);
  restoreSavedLocation();
  setDateTimeFromOffset(0);
  updateLocationBadge();
  renderCampusStrip();
  renderUsageChips();
  updateActiveFiltersBadge();
  bindEvents();

  if (window.innerWidth >= 1024) {
    initMap();
  }

  try {
    const resp = await fetch('./data/rooms.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    state.rooms = payload.rooms || [];
    refreshScheduleAndRender();
  } catch (err) {
    els.errorBanner.textContent = `Failed to load room catalog (data/rooms.json): ${err.message}`;
    els.errorBanner.classList.remove('hidden');
  }

  registerServiceWorker();
}

bootstrap();
