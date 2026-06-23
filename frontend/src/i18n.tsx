import { createContext, useContext, useState, ReactNode } from "react";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  tab_generate: "Generate",
  tab_library: "Library",
  tab_history: "History",
  tab_favorites: "Favorites",
  favorite: "Favorite",
  unfavorite: "Unfavorite",
  note_label: "Note",
  note_placeholder: "Name / annotate this prompt…",
  copy_prompt: "Copy prompt",
  copied: "Copied",
  prompt_label: "Prompt",
  favorites_empty:
    "No favorites yet. Hit ☆ on a generated image (in the viewer or library) and its prompt shows up here.",
  settings: "Settings",
  set_api_key: "Set Vertex",
  resize_sidebar: "Drag to resize sidebar; double-click to reset",
  no_key_warning:
    "Vertex project is not set. Click \"Set Vertex\" in the top-right and enter your Project ID to start generating.",

  settings_title: "Vertex AI settings (ADC)",
  settings_desc:
    "This app authenticates with ADC (Application Default Credentials) and stores no secrets — only the non-sensitive Project ID and Location.",
  settings_project: "Project ID",
  settings_location: "Location",
  settings_adc_hint:
    "Prerequisite: run `gcloud auth application-default login` and `... set-quota-project <PROJECT_ID>` on this machine, with the Vertex AI User role and the aiplatform API enabled. Location is usually `global`.",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  show_more: "Show more",
  show_less: "Show less",

  tray_label:
    "Reference images (upload new ones or pick from the library; drag to reorder)",
  tray_upload: "＋ Drag / click to upload",
  tray_drop_title: "Drop images to upload",
  tray_drop_hint: "Images will be added to the current reference list",

  prompt: "Prompt",
  prompt_placeholder:
    "Describe the edit/generation you want, e.g. compose these three product shots into a warm-toned poster…",
  model: "Model",
  aspect: "Aspect ratio",
  resolution: "Resolution",
  format: "Output format",
  pro_only: " (Pro only)",
  generate: "Generate",
  generating: "Generating…",
  ref_count: "{n} reference image(s)",
  need_key_inline: " · set Vertex project first",

  gen_success: "Success",
  use_as_ref: "Use as reference",
  download: "Download",
  blocked_title: "Blocked by safety policy",
  error_title: "Error",
  blocked_fallback: "The result was blocked by Google.",
  error_fallback: "Generation failed.",

  filter_all: "All",
  filter_upload: "Uploaded",
  filter_generated: "Generated",
  hist_filter_vertex: "Generated in app",
  hist_filter_manual: "Uploaded result",
  hist_filter_notes: "Notes",
  edit_annotation: "Edit note & tags",
  lib_hint: "Click an image to add it as a reference",
  columns_per_row: "Per row",
  density: "Density",
  fullscreen_manage: "Manage fullscreen",
  thumb_size: "Thumbnail size",
  tab_bin: "Bin",
  bin_title: "Recycle bin",
  bin_hint: "Deleted images stay here — restore them or delete permanently.",
  bin_empty_state: "The recycle bin is empty.",
  restore: "Restore",
  delete_forever: "Delete forever",
  empty_bin: "Empty bin",
  deleted_label: "Deleted",
  confirm_delete: "Move this image to the recycle bin?",
  confirm_purge: "Permanently delete this image? This cannot be undone.",
  confirm_empty_bin: "Empty the recycle bin? All images will be permanently deleted.",
  search_placeholder_library: "Search filename / tag…",
  search_placeholder_history: "Search prompt…",
  clear_search: "Clear search",
  no_results: "No matching results",
  clear_filters: "Clear filters",
  loading: "Loading…",
  prev_page: "Prev",
  next_page: "Next",
  page_status: "Page {page}/{pages} · {total}",
  lib_empty: "The library is empty — upload some images on the Generate page.",
  tag_upload: "Uploaded",
  tag_generated: "Generated",
  star: "Star",
  delete: "Delete",
  add_ref: "Add as reference",
  open_viewer: "View",

  // tags
  no_tags: "No tags yet",
  new_tag_placeholder: "New tag…",
  create: "Create",
  tags_label: "Tags",
  tags_all: "All",
  add_to_input: "Add to input",
  close: "Close",
  archive_to: "Archive into tags (auto-applied after generation: output + inputs)",
  select_mode: "Select",
  done: "Done",
  selected_n: "{n} selected",
  batch_add_tag: "Add tag",
  batch_remove_tag: "Remove tag",
  batch_download: "Download",
  clear_sel: "Clear",
  select_all: "Select all",
  deselect_all: "Deselect all",
  apply_to_selected: "Apply to selected",
  create_new_tag: "Create new tag",

  status_success: "Success",
  status_blocked: "Blocked",
  status_error: "Error",
  status_note: "Note",
  status_pending: "Queued",
  status_running: "Generating",
  status_cancelling: "Cancelling",
  status_aborted: "Cancelled",
  queue_title: "Queue",
  concurrency: "Parallel",
  concurrency_hint:
    "Number of generations run at once. For Pro (a preview model), 1 is recommended: parallel requests starve the low quota and all stall on 429.",
  undo_send: "Undo send ({n})",
  undo_send_hint: "Cancel within the countdown — the request hasn't been sent, so no charge.",
  cancel_running: "Cancel",
  cancel_running_hint:
    "Finishes the current attempt (saved to the library if it succeeds), then stops retrying. The in-flight attempt may still be billed if it already finished generating.",
  undo_send_seconds: "Send delay (seconds)",
  undo_send_seconds_hint:
    "Counts down before actually calling Vertex; cancelling within the window = no charge. 0 = send immediately.",
  aborted_fallback: "Cancelled.",
  phase_delaying: "Delaying send…",
  phase_queued: "Queued · waiting for a slot",
  phase_sent: "Sent · attempt {n}",
  phase_retrying: "Retrying ({code}) · in ~{n}s",
  phase_running: "Generating…",
  phase_cancelling: "Cancelling · finishing the current attempt (no more retries)",

  // Usage dashboard
  usage: "Usage",
  usage_title: "Usage",
  usage_range: "Range: {from} – {to}",
  usage_empty: "No generations yet.",
  stat_total: "Generations",
  stat_success_rate: "Success rate",
  stat_today: "Today",
  stat_last7: "Last 7 days",
  stat_images: "Library images",
  stat_storage: "Storage used",
  stat_tags: "Tags",
  by_status_title: "By status",
  by_model_title: "By model",
  usage_series: "Generations over time",
  usage_period: "Period",
  usage_empty_period: "No generations in this range yet.",
  bucket_day: "Day",
  bucket_week: "Week",
  bucket_month: "Month",
  bucket_year: "Year",
  bucket_all: "All",
  cost_estimate: "Estimated cost",
  cost_estimate_note:
    "Estimate · at your unit prices · counts successes only. Note: blocked results, and an attempt cancelled after it already finished generating, may also be billed by Vertex and are not counted here — so this is a lower bound. The app cannot see your real bill.",
  cost_example_note: "These are example prices — adjust to your actual Vertex rates.",
  cost_currency: "Currency",
  cost_unit_price: "Price / image",
  cost_count: "Successes",
  cost_subtotal: "Subtotal",
  cost_total: "Estimated total",
  clear_done: "Clear finished",
  remove_task: "Remove",
  reuse: "Reuse",
  reuse_generate: "Reuse & generate now",
  no_refs: "(no reference images)",
  no_output: "No output",
  history_empty: "No generations yet.",

  // Backend reason codes (block reasons + HTTP statuses)
  reason_SAFETY: "Blocked by Vertex AI's safety policy (SAFETY).",
  reason_IMAGE_SAFETY: "Image blocked by the safety policy (IMAGE_SAFETY).",
  reason_PROHIBITED_CONTENT: "Flagged as prohibited content (PROHIBITED_CONTENT).",
  reason_IMAGE_PROHIBITED_CONTENT:
    "Image flagged as prohibited content (IMAGE_PROHIBITED_CONTENT).",
  reason_RECITATION:
    "Blocked for likely reciting copyrighted content (RECITATION).",
  reason_IMAGE_RECITATION:
    "Image blocked for likely reciting copyrighted content (IMAGE_RECITATION).",
  reason_BLOCKLIST: "Hit the blocklist (BLOCKLIST).",
  reason_SPII: "Possibly involves sensitive personal information (SPII).",
  reason_IMAGE_OTHER: "Image was not produced for another reason (IMAGE_OTHER).",
  reason_NO_IMAGE: "The model did not produce an image (NO_IMAGE).",
  reason_JAILBREAK: "Request flagged as a jailbreak attempt (JAILBREAK).",
  reason_MODEL_ARMOR: "Blocked by the Model Armor policy (MODEL_ARMOR).",
  reason_400: "Bad request parameters (400).",
  reason_401: "Invalid or unauthorized credentials (401).",
  reason_403: "Permission denied (403): ensure the account has the Vertex AI User role and the aiplatform API is enabled.",
  reason_404: "Model not found or unavailable in this region (404).",
  reason_429: "Quota / rate limit reached (429).",

  add_history: "Add",
  add_history_title: "Add history record",
  add_history_desc:
    "Save a result made elsewhere (another tool/model) into History, alongside real generations.",
  add_history_output: "Output image",
  add_history_status: "Status",
  add_history_error_message: "Error message",
  add_history_created_at: "Created at (optional — leave blank for now)",
  add_history_need_output: "An output image is required when status is Success.",
  pick_from_library: "Pick from library",
  note_no_output: "This is a note — no output image.",
};

const en: Dict = {
  tab_generate: "Generate",
  tab_library: "Library",
  tab_history: "History",
  tab_favorites: "Favorites",
  favorite: "Favorite",
  unfavorite: "Unfavorite",
  note_label: "Note",
  note_placeholder: "Name / annotate this prompt…",
  copy_prompt: "Copy prompt",
  copied: "Copied",
  prompt_label: "Prompt",
  favorites_empty:
    "No favorites yet. Hit ☆ on a generated image (in the viewer or library) and its prompt shows up here.",
  settings: "Settings",
  set_api_key: "Set Vertex",
  resize_sidebar: "Drag to resize sidebar; double-click to reset",
  no_key_warning:
    "Vertex project is not set. Click “Set Vertex” in the top-right and enter your Project ID to start generating.",

  settings_title: "Vertex AI settings (ADC)",
  settings_desc:
    "This app authenticates with ADC (Application Default Credentials) and stores no secrets — only the non-sensitive Project ID and Location.",
  settings_project: "Project ID",
  settings_location: "Location",
  settings_adc_hint:
    "Prerequisite: run `gcloud auth application-default login` and `... set-quota-project <PROJECT_ID>` on this machine, with the Vertex AI User role and the aiplatform API enabled. Location is usually `global`.",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  show_more: "Show more",
  show_less: "Show less",

  tray_label:
    "Reference images (upload new ones or pick from the library; drag to reorder)",
  tray_upload: "＋ Drag / click to upload",
  tray_drop_title: "Drop images to upload",
  tray_drop_hint: "Images will be added to the current reference list",

  prompt: "Prompt",
  prompt_placeholder:
    "Describe the edit/generation you want, e.g. compose these three product shots into a warm-toned poster…",
  model: "Model",
  aspect: "Aspect ratio",
  resolution: "Resolution",
  format: "Output format",
  pro_only: " (Pro only)",
  generate: "Generate",
  generating: "Generating…",
  ref_count: "{n} reference image(s)",
  need_key_inline: " · set Vertex project first",

  gen_success: "Success",
  use_as_ref: "Use as reference",
  download: "Download",
  blocked_title: "Blocked by safety policy",
  error_title: "Error",
  blocked_fallback: "The result was blocked by Google.",
  error_fallback: "Generation failed.",

  filter_all: "All",
  filter_upload: "Uploaded",
  filter_generated: "Generated",
  hist_filter_vertex: "Generated in app",
  hist_filter_manual: "Uploaded result",
  hist_filter_notes: "Notes",
  edit_annotation: "Edit note & tags",
  lib_hint: "Click an image to add it as a reference",
  columns_per_row: "Per row",
  density: "Density",
  fullscreen_manage: "Manage fullscreen",
  thumb_size: "Thumbnail size",
  tab_bin: "Bin",
  bin_title: "Recycle bin",
  bin_hint: "Deleted images stay here — restore them or delete permanently.",
  bin_empty_state: "The recycle bin is empty.",
  restore: "Restore",
  delete_forever: "Delete forever",
  empty_bin: "Empty bin",
  deleted_label: "Deleted",
  confirm_delete: "Move this image to the recycle bin?",
  confirm_purge: "Permanently delete this image? This cannot be undone.",
  confirm_empty_bin: "Empty the recycle bin? All images will be permanently deleted.",
  search_placeholder_library: "Search filename / tag…",
  search_placeholder_history: "Search prompt…",
  clear_search: "Clear search",
  no_results: "No matching results",
  clear_filters: "Clear filters",
  loading: "Loading…",
  prev_page: "Prev",
  next_page: "Next",
  page_status: "Page {page}/{pages} · {total}",
  lib_empty: "The library is empty — upload some images on the Generate page.",
  tag_upload: "Uploaded",
  tag_generated: "Generated",
  star: "Star",
  delete: "Delete",
  add_ref: "Add as reference",
  open_viewer: "View",

  // tags
  no_tags: "No tags yet",
  new_tag_placeholder: "New tag…",
  create: "Create",
  tags_label: "Tags",
  tags_all: "All",
  add_to_input: "Add to input",
  close: "Close",
  archive_to: "Archive into tags (auto-applied after generation: output + inputs)",
  select_mode: "Select",
  done: "Done",
  selected_n: "{n} selected",
  batch_add_tag: "Add tag",
  batch_remove_tag: "Remove tag",
  batch_download: "Download",
  clear_sel: "Clear",
  select_all: "Select all",
  deselect_all: "Deselect all",
  apply_to_selected: "Apply to selected",
  create_new_tag: "Create new tag",

  status_success: "Success",
  status_blocked: "Blocked",
  status_error: "Error",
  status_note: "Note",
  status_pending: "Queued",
  status_running: "Generating",
  status_cancelling: "Cancelling",
  status_aborted: "Cancelled",
  queue_title: "Queue",
  concurrency: "Parallel",
  concurrency_hint:
    "Number of generations run at once. For Pro (a preview model), 1 is recommended: parallel requests starve the low quota and all stall on 429.",
  undo_send: "Undo send ({n})",
  undo_send_hint: "Cancel within the countdown — the request hasn't been sent, so no charge.",
  cancel_running: "Cancel",
  cancel_running_hint:
    "Finishes the current attempt (saved to the library if it succeeds), then stops retrying. The in-flight attempt may still be billed if it already finished generating.",
  undo_send_seconds: "Send delay (seconds)",
  undo_send_seconds_hint:
    "Counts down before actually calling Vertex; cancelling within the window = no charge. 0 = send immediately.",
  aborted_fallback: "Cancelled.",
  phase_delaying: "Delaying send…",
  phase_queued: "Queued · waiting for a slot",
  phase_sent: "Sent · attempt {n}",
  phase_retrying: "Retrying ({code}) · in ~{n}s",
  phase_running: "Generating…",
  phase_cancelling: "Cancelling · finishing the current attempt (no more retries)",

  // Usage dashboard
  usage: "Usage",
  usage_title: "Usage",
  usage_range: "Range: {from} – {to}",
  usage_empty: "No generations yet.",
  stat_total: "Generations",
  stat_success_rate: "Success rate",
  stat_today: "Today",
  stat_last7: "Last 7 days",
  stat_images: "Library images",
  stat_storage: "Storage used",
  stat_tags: "Tags",
  by_status_title: "By status",
  by_model_title: "By model",
  usage_series: "Generations over time",
  usage_period: "Period",
  usage_empty_period: "No generations in this range yet.",
  bucket_day: "Day",
  bucket_week: "Week",
  bucket_month: "Month",
  bucket_year: "Year",
  bucket_all: "All",
  cost_estimate: "Estimated cost",
  cost_estimate_note:
    "Estimate · at your unit prices · counts successes only. Note: blocked results, and an attempt cancelled after it already finished generating, may also be billed by Vertex and are not counted here — so this is a lower bound. The app cannot see your real bill.",
  cost_example_note: "These are example prices — adjust to your actual Vertex rates.",
  cost_currency: "Currency",
  cost_unit_price: "Price / image",
  cost_count: "Successes",
  cost_subtotal: "Subtotal",
  cost_total: "Estimated total",
  clear_done: "Clear finished",
  remove_task: "Remove",
  reuse: "Reuse",
  reuse_generate: "Reuse & generate now",
  no_refs: "(no reference images)",
  no_output: "No output",
  history_empty: "No generations yet.",

  reason_SAFETY: "Blocked by Vertex AI’s safety policy (SAFETY).",
  reason_IMAGE_SAFETY: "Image blocked by the safety policy (IMAGE_SAFETY).",
  reason_PROHIBITED_CONTENT: "Flagged as prohibited content (PROHIBITED_CONTENT).",
  reason_IMAGE_PROHIBITED_CONTENT:
    "Image flagged as prohibited content (IMAGE_PROHIBITED_CONTENT).",
  reason_RECITATION:
    "Blocked for likely reciting copyrighted content (RECITATION).",
  reason_IMAGE_RECITATION:
    "Image blocked for likely reciting copyrighted content (IMAGE_RECITATION).",
  reason_BLOCKLIST: "Hit the blocklist (BLOCKLIST).",
  reason_SPII: "Possibly involves sensitive personal information (SPII).",
  reason_IMAGE_OTHER: "Image was not produced for another reason (IMAGE_OTHER).",
  reason_NO_IMAGE: "The model did not produce an image (NO_IMAGE).",
  reason_JAILBREAK: "Request flagged as a jailbreak attempt (JAILBREAK).",
  reason_MODEL_ARMOR: "Blocked by the Model Armor policy (MODEL_ARMOR).",
  reason_400: "Bad request parameters (400).",
  reason_401: "Invalid or unauthorized credentials (401).",
  reason_403: "Permission denied (403): ensure the account has the Vertex AI User role and the aiplatform API is enabled.",
  reason_404: "Model not found or unavailable in this region (404).",
  reason_429: "Quota / rate limit reached (429).",

  add_history: "Add",
  add_history_title: "Add history record",
  add_history_desc:
    "Save a result made elsewhere (another tool/model) into History, alongside real generations.",
  add_history_output: "Output image",
  add_history_status: "Status",
  add_history_error_message: "Error message",
  add_history_created_at: "Created at (optional — leave blank for now)",
  add_history_need_output: "An output image is required when status is Success.",
  pick_from_library: "Pick from library",
  note_no_output: "This is a note — no output image.",
};

const DICTS: Record<Lang, Dict> = { zh, en };

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  reason: (code: string | null | undefined) => string | null;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectInitial(): Lang {
  const saved = localStorage.getItem("lang");
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitial);

  const setLang = (l: Lang) => {
    localStorage.setItem("lang", l);
    setLangState(l);
  };

  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(`{${k}}`, String(v));
      }
    }
    return s;
  };

  // Localize a backend reason code; null when unknown (caller falls back).
  const reason = (code: string | null | undefined) => {
    if (!code) return null;
    const key = `reason_${code}`;
    return DICTS[lang][key] ?? null;
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t, reason }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
