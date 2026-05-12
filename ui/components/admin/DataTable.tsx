'use client';
import { useState, ReactNode } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  RowSelectionState,
  SortingState,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// =========================================================================
// LEGACY render-prop table (still used by /admin/finance). Kept verbatim so
// pages outside the v0.2 TanStack migration keep building. New pages should
// use <DataTableV2 /> below.
// =========================================================================

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
}

interface LegacyProps<T> {
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
  rows,
  columns,
  keyFn,
  empty,
  loading,
  page,
  pageSize,
  total,
  onPage,
}: LegacyProps<T>) {
  return (
    <div className="bg-card rounded-lg border border-border overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground bg-muted border-b border-border">
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
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-border/50 last:border-b-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3">
                      <Skeleton className="h-5 w-full max-w-[140px]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-muted-foreground">
                  {empty ?? '暂无数据'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={keyFn(row)}
                  className="border-b border-border/50 last:border-b-0 hover:bg-muted/60"
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-4 py-3 ${c.className ?? ''}`}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {onPage && pageSize && page != null && (
        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <div>
            {total != null ? `共 ${total} 条 · 第 ${page + 1} 页` : `第 ${page + 1} 页`}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => onPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2.5 py-1 rounded border border-input disabled:opacity-40 hover:bg-muted"
            >
              上一页
            </button>
            <button
              onClick={() => onPage(page + 1)}
              disabled={total != null && (page + 1) * pageSize >= total}
              className="px-2.5 py-1 rounded border border-input disabled:opacity-40 hover:bg-muted"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =========================================================================
// v2 — TanStack-powered table with sort / filter / pagination / row-selection
// / bulk-actions. Used by /admin/users, /admin/orders (P0 #4).
// =========================================================================

export interface DataTableV2Props<T> {
  columns: ColumnDef<T, any>[];
  data: T[];
  loading?: boolean;
  /** key used by the search input to filter rows (case-insensitive substring) */
  searchKey?: keyof T & string;
  searchPlaceholder?: string;
  /** bulk action buttons; shown only when ≥1 row selected */
  bulkActions?: {
    label: string;
    onClick: (selected: T[]) => void;
    variant?: 'default' | 'outline' | 'destructive' | 'secondary';
  }[];
  /** rows per page (default 20) */
  pageSize?: number;
  /** message when no rows */
  emptyMessage?: ReactNode;
  /** extra toolbar slot rendered next to the search bar */
  toolbar?: ReactNode;
}

export function DataTableV2<T>({
  columns,
  data,
  loading,
  searchKey,
  searchPlaceholder,
  bulkActions,
  pageSize = 20,
  emptyMessage,
  toolbar,
}: DataTableV2Props<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    globalFilterFn: searchKey
      ? (row, _colId, value) => {
          const v = String((row.original as any)[searchKey] ?? '').toLowerCase();
          return v.includes(String(value).toLowerCase());
        }
      : 'includesString',
  });

  const selected = table.getSelectedRowModel().rows.map((r) => r.original);
  const filteredTotal = table.getFilteredRowModel().rows.length;
  const pageIndex = table.getState().pagination.pageIndex;
  const ps = table.getState().pagination.pageSize;
  const showingFrom = filteredTotal === 0 ? 0 : pageIndex * ps + 1;
  const showingTo = Math.min((pageIndex + 1) * ps, filteredTotal);

  return (
    <div className="space-y-3">
      {(searchKey || toolbar || bulkActions) && (
        <div className="flex items-center gap-3 flex-wrap">
          {searchKey && (
            <Input
              placeholder={searchPlaceholder || `按 ${searchKey} 搜索…`}
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="max-w-sm h-9"
            />
          )}
          {toolbar}
          <div className="flex-1" />
          {bulkActions && selected.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>已选 {selected.length} 行</span>
              {bulkActions.map((act, i) => (
                <Button
                  key={i}
                  variant={act.variant ?? 'outline'}
                  size="sm"
                  onClick={() => act.onClick(selected)}
                >
                  {act.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-card rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="bg-muted/40 hover:bg-muted/40">
                {hg.headers.map((h) => {
                  const sort = h.column.getIsSorted() as 'asc' | 'desc' | false;
                  const canSort = h.column.getCanSort();
                  return (
                    <TableHead
                      key={h.id}
                      onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                      className={cn(
                        'h-10 text-xs',
                        canSort && 'cursor-pointer select-none hover:text-foreground',
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {h.isPlaceholder
                          ? null
                          : flexRender(h.column.columnDef.header, h.getContext())}
                        {sort === 'asc' && <span className="text-muted-foreground"> ↑</span>}
                        {sort === 'desc' && <span className="text-muted-foreground"> ↓</span>}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {columns.map((_c, j) => (
                    <TableCell key={j} className="py-2.5">
                      <Skeleton className="h-5 w-full max-w-[120px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center py-12 text-muted-foreground text-sm"
                >
                  {emptyMessage ?? '暂无数据'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                >
                  {row.getVisibleCells().map((c) => (
                    <TableCell key={c.id} className="py-2.5">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <div>
          {filteredTotal === 0
            ? '0 条'
            : `第 ${showingFrom}-${showingTo} 条 / 共 ${filteredTotal} 条`}
          {globalFilter && data.length !== filteredTotal && (
            <span className="ml-1">（已筛选自 {data.length}）</span>
          )}
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            className="h-7 px-2"
          >
            首页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="h-7 px-2"
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="h-7 px-2"
          >
            下一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
            className="h-7 px-2"
          >
            末页
          </Button>
        </div>
      </div>
    </div>
  );
}
