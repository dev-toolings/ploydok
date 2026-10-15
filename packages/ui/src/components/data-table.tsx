// SPDX-License-Identifier: AGPL-3.0-only
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"

import { cn } from "@workspace/ui/lib/utils"
import { Button } from "@workspace/ui/components/button"
import type { ColumnDef, Table as ReactTable } from "@tanstack/react-table"

interface DataTableProps<TData> {
  columns: Array<ColumnDef<TData>>
  rows: Array<TData>
  pageSize?: number
  onRowClick?: (row: TData) => void
  className?: string
  /** Set false when pagination is owned by the server. */
  paginate?: boolean
  /** Drops the rounded frame when a bordered table card already wraps it. */
  flush?: boolean
}

function DataTable<TData>({
  columns,
  rows,
  pageSize = 5,
  onRowClick,
  className,
  paginate = true,
  flush = false,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(paginate ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    initialState: {
      pagination: {
        pageSize,
        pageIndex: 0,
      },
    },
  })

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className={cn(
          "overflow-x-auto bg-background",
          flush
            ? "border-y border-[#ebebeb] dark:border-neutral-800"
            : "-mx-3 rounded-2xl border border-[#ebebeb] sm:mx-0 dark:border-neutral-800"
        )}
      >
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-[#ebebeb] bg-[#f7f7f7] dark:border-neutral-800 dark:bg-[#151515]">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2.5 text-left font-medium whitespace-nowrap text-neutral-400 dark:text-neutral-500"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-slot="data-table-row"
                className={cn(
                  "border-b border-[#ebebeb] transition-colors last:border-0 dark:border-neutral-800",
                  onRowClick &&
                    "cursor-pointer hover:bg-[#f7f7f7]/70 dark:hover:bg-neutral-900"
                )}
                onClick={() => onRowClick?.(row.original)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="h-[58px] px-3 py-2 font-medium text-foreground"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {paginate ? <DataTablePagination table={table} /> : null}
    </div>
  )
}

interface DataTablePaginationProps<TData> {
  table: ReactTable<TData>
}

function DataTablePagination<TData>({
  table,
}: DataTablePaginationProps<TData>) {
  const currentPage = table.getState().pagination.pageIndex + 1
  const totalPages = table.getPageCount()

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground">
        Page {currentPage} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => table.previousPage()}
        disabled={!table.getCanPreviousPage()}
      >
        Prev
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => table.nextPage()}
        disabled={!table.getCanNextPage()}
      >
        Next
      </Button>
    </div>
  )
}

export type { DataTableProps, DataTablePaginationProps }
export type { ColumnDef }
export { DataTable, DataTablePagination }
