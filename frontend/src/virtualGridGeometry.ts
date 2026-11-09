export interface VirtualGridGeometry {
  count: number;
  cols: number;
  // Item height plus the gap between rows.
  rowHeight: number;
  itemHeight: number;
  // Extra vertical space for a section heading, including the gap after it.
  headerHeight: number;
  // Item indexes that start a section, sorted and de-duplicated.
  sections: number[];
  sectionRows: number[];
}

export function sectionRowsFor(
  count: number,
  cols: number,
  sections: number[] | undefined,
): number[] {
  const rows = Math.ceil(count / cols);
  return [...new Set((sections ?? []).map((index) => Math.floor(index / cols)))]
    .filter((row) => row >= 0 && row < rows)
    .sort((a, b) => a - b);
}

export function headersBefore(sectionRows: number[], row: number): number {
  let lo = 0;
  let hi = sectionRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sectionRows[mid] < row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Top of a grid row, including all headings before it. */
export function rowTop(geometry: VirtualGridGeometry, row: number): number {
  return (
    row * geometry.rowHeight +
    headersBefore(geometry.sectionRows, row) * geometry.headerHeight
  );
}

/** Top of one item, after that row's heading when it has one. */
export function itemTop(
  geometry: VirtualGridGeometry,
  index: number,
): number {
  const row = Math.floor(index / geometry.cols);
  return (
    rowTop(geometry, row) +
    (geometry.sectionRows.includes(row) ? geometry.headerHeight : 0)
  );
}

export function totalGridHeight(
  geometry: VirtualGridGeometry,
  gap: number,
): number {
  const rows = Math.ceil(geometry.count / geometry.cols);
  return rows > 0
    ? Math.max(
        0,
        rows * geometry.rowHeight -
          gap +
          geometry.sectionRows.length * geometry.headerHeight,
      )
    : 0;
}

/** Greatest row whose top is at or above `y`. */
export function rowAtY(geometry: VirtualGridGeometry, y: number): number {
  const rows = Math.ceil(geometry.count / geometry.cols);
  if (rows <= 0) return 0;
  let lo = 0;
  let hi = rows - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowTop(geometry, mid) <= y) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
