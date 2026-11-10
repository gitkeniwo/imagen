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

## Series follow-ups (after Series v2)

Left out of `docs/plans/series-v2.md` on purpose; each is independent.

- **Wide Series workspace.** Add a Series tab to `FullscreenManager` (today the
  Series page's fullscreen button opens Library). Wide screens get
  master-detail: the theme/series tree on the left, the detail on the right, so
  the Changes view, long prompts and diffs have room. Narrow screens keep the
  current drill-down.
- **Queue: series and expected number.** Queue cards show the series badge
  from v2; add the expected position ("→ #19") while a task is queued or
  running, and settle it when the record is written.
- **Compare and merge.** Pick two attempts or versions and compare them side by
  side (prompt diff + params + outputs). Merge two series into one, keeping
  custom order and marks.
- **Search, filter, sort.** Search prompts inside a series and across series;
  filter by picks/rejects; sort the series list (activity, name, oldest first).
- **Series stats performance.** `_stats` scans every generation on each tree
  reload. Split a cheap summary endpoint (counts, last activity, cover) from
  the detail, or keep per-series counters, once libraries grow large.
- **Rewrite times from series order.** One action that rewrites `created_at` of
  a series' manual records to follow its custom order, spread inside the
  original time range, so History matches the series. Real provider calls keep
  their times.
- **Branch tree.** A git-like tree of which version a try was derived from.
  Much larger than v2's linear Changes view; only if the linear view proves
  insufficient.
