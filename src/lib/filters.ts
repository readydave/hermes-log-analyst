import type { EventFilters, NormalizedEvent } from "../types/events";

export const defaultFilters: EventFilters = {
  text: "",
  severities: {
    information: true,
    warning: true,
    error: true,
    critical: true
  },
  category: "all",
  eventId: "",
  source: "",
  dateFrom: "",
  dateTo: ""
};

function parseLocalDateStart(value: string): number | null {
  if (!value) return null;
  if (value.includes("-")) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
}

function parseLocalDateEnd(value: string): number | null {
  if (!value) return null;
  if (value.includes("-")) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

export function applyFilters(events: NormalizedEvent[], filters: EventFilters): NormalizedEvent[] {
  return events.filter((event) => {
    if (!filters.severities[event.severity]) return false;
    if (filters.category !== "all" && event.category !== filters.category) return false;

    if (filters.eventId.trim()) {
      const target = Number(filters.eventId);
      if (Number.isNaN(target) || event.eventId !== target) return false;
    }

    if (filters.source.trim() && !event.provider.toLowerCase().includes(filters.source.toLowerCase())) {
      return false;
    }

    if (filters.text.trim()) {
      const haystack = `${event.message} ${event.logName}`.toLowerCase();
      if (!haystack.includes(filters.text.toLowerCase())) return false;
    }

    const eventTime = Date.parse(event.timestamp);
    let start = parseLocalDateStart(filters.dateFrom);
    let end = parseLocalDateEnd(filters.dateTo);
    if (start !== null && end !== null && start > end) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    if (start !== null && eventTime < start) return false;
    if (end !== null && eventTime > end) return false;

    return true;
  });
}
