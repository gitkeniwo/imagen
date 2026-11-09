import { api, type ImageRow, type LibraryFilters } from "./api";
import { CHUNK, useChunkedList } from "./useChunkedList";

export { CHUNK };
export type { RefreshResult } from "./useChunkedList";

/** Library's image fetch plugged into the shared chunked-list hook. */
export function useChunkedImages(
  filters: LibraryFilters,
  filtersKey: string,
  onRows?: (rows: ImageRow[]) => void,
) {
  return useChunkedList<ImageRow>({
    key: filtersKey,
    fetchChunk: async (offset, limit, signal) => {
      const result = await api.listImages({ ...filters, offset, limit }, signal);
      return { rows: result.images, total: result.total };
    },
    fetchIds: async (offset, limit, signal) =>
      (await api.listImageIds({ ...filters, offset, limit }, signal)).ids,
    idOf: (image) => image.id,
    onRows,
  });
}
