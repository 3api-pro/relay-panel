'use client';
import { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  keyFn: (row: T) => string | number;
  empty?: ReactNode;
  loading?: boolean;
  page?: number;
  pageSize?: number;
  total?: number;
  onPage?: (p: number) => void;
}

export function DataTable<T>({
  rows, columns, keyFn, empty, loading,
  page, pageSize, total, onPage,
}: Props<T>) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500 bg-slate-50 border-b border-slate-200">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`px-4 py-2.5 font-medium ${c.className ?? ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-slate-400">加载中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-slate-400">{empty ?? '暂无数据'}</td></tr>
            ) : (
              rows.map((row) => (
                <tr key={keyFn(row)} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60">
                  {columns.map((c) => (
                    <td key={c.key} className={`px-4 py-3 ${c.className ?? ''}`}>{c.render(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {onPage && pageSize && (page != null) && (
        <div className="px-4 py-2.5 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <div>
            {total != null
              ? `共 ${total} 条 · 第 ${page + 1} 页`
              : `第 ${page + 1} 页`}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => onPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2.5 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50"
            >上一页</button>
            <button
              onClick={() => onPage(page + 1)}
              disabled={total != null && (page + 1) * pageSize >= total}
              className="px-2.5 py-1 rounded border border-slate-300 disabled:opacity-40 hover:bg-slate-50"
            >下一页</button>
          </div>
        </div>
      )}
    </div>
  );
}
