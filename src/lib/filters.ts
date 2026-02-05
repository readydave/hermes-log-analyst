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
    if (filters.dateFrom && eventTime < Date.parse(filters.dateFrom)) return false;
    if (filters.dateTo && eventTime > Date.parse(`${filters.dateTo}T23:59:59`)) return false;

    return true;
  });
}
