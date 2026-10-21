import {
  Bookmark,
  ChartColumn,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyPlus,
  CornerUpLeft,
  Download,
  Ellipsis,
  Eraser,
  FolderInput,
  History,
  ImageOff,
  ImagePlus,
  Images,
  Import,
  Languages,
  LayoutGrid,
  List,
  ListFilter,
  ListPlus,
  type LucideIcon,
  Maximize2,
  Minus,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheck,
  Star,
  StickyNote,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  ArrowRight,
} from "lucide-react";

// The icon dictionary: one name per meaning, one glyph per name. Pick icons by
// what the action does, never by what looks close — if a meaning is missing,
// add a name here instead of reusing a glyph that already means something else.
const ICONS = {
  // Navigation / panels
  library: Images,
  history: History,
  favorite: Star,
  drafts: StickyNote,
  bin: Trash2,
  fullscreen: Maximize2,
  usage: ChartColumn,
  settings: Settings,
  warning: TriangleAlert,
  // Record & image actions
  reuse: CornerUpLeft,
  rerun: RotateCw,
  queue: ListPlus,
  addToRefs: ImagePlus,
  saveDraft: StickyNote,
  moveToDrafts: FolderInput,
  edit: Pencil,
  editSettings: SlidersHorizontal,
  duplicate: CopyPlus,
  copy: Copy,
  marker: Bookmark,
  pin: Pin,
  download: Download,
  delete: Trash2,
  restore: RotateCcw,
  tag: Tag,
  untag: Eraser,
  pickFromLibrary: Images,
  upload: Upload,
  // Sources
  generated: Sparkles,
  uploaded: Upload,
  imported: Import,
  // Selection
  selectMode: SquareCheck,
  selectAll: CheckCheck,
  deselect: Square,
  check: Check,
  // Generic
  add: Plus,
  remove: Minus,
  close: X,
  search: Search,
  prev: ChevronLeft,
  next: ChevronRight,
  chevronDown: ChevronDown,
  arrowRight: ArrowRight,
  columns: LayoutGrid,
  listView: List,
  filter: ListFilter,
  more: Ellipsis,
  language: Languages,
  imageMissing: ImageOff,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export default function Icon({
  name,
  size = "md",
  filled = false,
  className,
}: {
  name: IconName;
  size?: "sm" | "md" | "lg";
  filled?: boolean;
  className?: string;
}) {
  const Glyph = ICONS[name];
  const cls = ["icon", `icon-${size}`, filled && "icon-filled", className]
    .filter(Boolean)
    .join(" ");
  return <Glyph className={cls} aria-hidden="true" focusable="false" />;
}
