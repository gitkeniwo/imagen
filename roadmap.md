# Roadmap

Ideas that are agreed in principle but not scheduled yet.

## Sidebar grid fills the available height

The compact Library and Favorites grids use a fixed page size today (24,
rounded up to whole rows by `pageSizedToColumns`), so the last row is cut off
by the sidebar's bottom edge and the list scrolls.

Instead, size each page to exactly what fits:

- Measure the grid area with a `ResizeObserver`. Tiles are square, so
  `tile = (width - (columns - 1) * gap) / columns` and
  `rows = max(1, floor((height + gap) / (tile + gap)))`; page size is
  `columns * rows`.
- Search, filters, tags and the pager stay pinned above the grid so the grid
  gets all remaining height; the grid itself no longer scrolls.
- Debounce refetches while the window or sidebar is being resized (~150 ms),
  and keep the first visible image on screen by recomputing the page as
  `floor(firstIndex / newPageSize)`.
- Only for grids with fixed-height tiles (Library, Favorites). History and
  Drafts cards vary in height and keep scrolling.

Cost is low: the observer fires only on size changes and fewer tiles are
rendered than today. The trade-off is that the mouse wheel no longer moves
through the grid; paging is Prev/Next only.
