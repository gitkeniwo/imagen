/**
 * Fit a page size to a grid's column count.
 *
 * A fixed page size leaves the last row of every page short (24 images in a
 * 5-column grid = 4 full rows + 4 tiles), which looks like a missing
 * thumbnail in the bottom-right corner. Rounding the target up to a whole
 * number of rows keeps every row on every page complete.
 */
export function pageSizedToColumns(target: number, columns: number): number {
  const cols = Math.max(1, Math.floor(columns));
  return cols * Math.ceil(target / cols);
}
