/**
 * Where a dashboard number leads.
 *
 * The server hands every drillable number a `drill` object — the exact filter
 * that produced it (see server/lib/insights.js). The client never builds those
 * filters itself; it only turns them into a URL. That is what keeps a tile's
 * count and the list it opens from ever disagreeing.
 */

function toQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function drillHref(drill) {
  if (!drill) return null;
  if (drill.view === 'visitors') return `/console/people${toQuery(drill.params)}`;
  return `/console/visits${toQuery(drill.params)}`;
}

export const personHref = (visitorId) => `/console/people/${visitorId}`;

export { toQuery };
