import { qs } from '@/lib/api';

/** Download links for the current filters; the proxy streams the file from the API. */
export function ExportLinks({ query }: { query: Record<string, string | number | undefined> }) {
  const filters = { ...query, limit: undefined };
  const href = (format: 'csv' | 'ndjson') =>
    `/api/proxy/events/export${qs({ ...filters, format })}`;
  return (
    <div className="flex items-center gap-2 text-sm" aria-label="Export events">
      <span className="text-slate-500 dark:text-slate-400">Export</span>
      <a
        href={href('csv')}
        download
        className="rounded-md px-2.5 py-1 font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
      >
        CSV
      </a>
      <a
        href={href('ndjson')}
        download
        className="rounded-md px-2.5 py-1 font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-800"
      >
        NDJSON
      </a>
    </div>
  );
}
