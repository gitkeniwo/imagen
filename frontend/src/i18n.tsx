import { createContext, useContext, useState, ReactNode } from "react";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  tab_generate: "生成",
  tab_library: "图库",
  tab_history: "历史",
  tab_favorites: "收藏",
  tab_drafts: "草稿箱",
  favorite: "收藏",
  unfavorite: "取消收藏",
  note_label: "备注",
  note_placeholder: "命名 / 标注这条提示词…",
  copy_prompt: "复制提示词",
  copied: "已复制",
  prompt_label: "提示词",
  favorites_empty:
    "还没有收藏。在生成的图片上（查看器或图库里）点 ☆，它的提示词就会出现在这里。",
  settings: "设置",
  set_api_key: "设置 Vertex",
  resize_sidebar: "拖动调整侧栏宽度；双击重置",
  no_key_warning:
    "尚未设置 Vertex 项目。点击右上角“设置 Vertex”并填入你的 Project ID 即可开始生成。",

  settings_title: "Vertex AI 设置（ADC）",
  settings_desc:
    "本应用使用 ADC（应用默认凭据）进行认证，不存储任何密钥——仅保存非敏感的 Project ID 与 Location。",
  settings_project: "Project ID",
  settings_location: "Location",
  settings_adc_hint:
    "前置条件：在本机运行 `gcloud auth application-default login` 和 `... set-quota-project <PROJECT_ID>`，账号需具备 Vertex AI User 角色并已启用 aiplatform API。Location 通常填 `global`。",
  cancel: "取消",
  save: "保存",
  saving: "保存中…",
  show_more: "展开",
  show_less: "收起",

  tray_label:
    "参考图（上传新图或从图库选取；拖动可排序）",
  tray_upload: "＋ 拖入 / 点击上传",
  tray_drop_title: "拖入图片以上传",
  tray_drop_hint: "图片将被加入当前参考列表",

  prompt: "提示词",
  prompt_placeholder:
    "描述你想要的编辑/生成，例如：把这三张产品图合成一张暖色调海报…",
  model: "模型",
  aspect: "宽高比",
  resolution: "分辨率",
  format: "输出格式",
  pro_only: "（仅 Pro）",
  generate: "生成",
  generating: "生成中…",
  ref_count: "{n} 张参考图",
  need_key_inline: " · 请先设置 Vertex 项目",

  gen_success: "成功",
  use_as_ref: "用作参考图",
  download: "下载",
  blocked_title: "被安全策略拦截",
  error_title: "出错",
  blocked_fallback: "结果被 Google 拦截。",
  error_fallback: "生成失败。",

  filter_all: "全部",
  filter_upload: "上传的",
  filter_generated: "生成的",
  hist_filter_vertex: "应用内生成",
  hist_filter_manual: "手动上传的结果",
  hist_filter_with_image: "仅有图",
  hist_filter_notes: "备注",
  edit_annotation: "编辑备注与标签",
  lib_hint: "点击图片将其加为参考图",
  columns_per_row: "每行数量",
  density: "密度",
  fullscreen_manage: "全屏管理",
  thumb_size: "缩略图大小",
  tab_bin: "回收站",
  bin_title: "回收站",
  bin_hint: "已删除的图片保留在这里——可恢复或永久删除。",
  bin_empty_state: "回收站是空的。",
  restore: "恢复",
  delete_forever: "永久删除",
  empty_bin: "清空回收站",
  deleted_label: "已删除",
  confirm_delete: "将这张图片移入回收站？",
  confirm_purge: "永久删除这张图片？此操作不可撤销。",
  confirm_empty_bin: "清空回收站？所有图片将被永久删除。",
  search_placeholder_library: "搜索文件名 / 标签…",
  search_placeholder_history: "搜索提示词…",
  clear_search: "清除搜索",
  no_results: "没有匹配的结果",
  clear_filters: "清除筛选",
  loading: "加载中…",
  load_error: "加载失败：{msg}",
  retry: "重试",
  lang_toggle: "切换语言",
  op_failed: "操作失败：{msg}",
  submit_shortcut_hint: "也可用 Cmd/Ctrl + Enter 提交",
  prev_page: "上一页",
  next_page: "下一页",
  page_status: "第 {page}/{pages} 页 · 共 {total}",
  lib_empty: "图库是空的——在生成页上传一些图片吧。",
  tag_upload: "上传的",
  tag_generated: "生成的",
  toggle_source_hint: "点击切换 上传的 / 生成的",
  star: "收藏",
  delete: "删除",
  add_ref: "加为参考图",
  open_viewer: "查看",

  // tags
  no_tags: "还没有标签",
  new_tag_placeholder: "新标签…",
  create: "创建",
  tags_label: "标签",
  tags_all: "全部",
  add_to_input: "加入输入",
  close: "关闭",
  archive_to: "归档到标签（生成后自动应用：输出 + 输入）",
  select_mode: "选择",
  done: "完成",
  selected_n: "已选 {n} 项",
  batch_add_tag: "添加标签",
  batch_remove_tag: "移除标签",
  batch_download: "下载",
  clear_sel: "清除",
  select_all: "全选",
  deselect_all: "取消全选",
  apply_to_selected: "应用到所选",
  create_new_tag: "创建新标签",

  status_success: "成功",
  status_blocked: "已拦截",
  status_error: "出错",
  status_note: "备注",
  status_draft: "草稿",
  status_pending: "排队中",
  status_running: "生成中",
  status_cancelling: "取消中",
  status_aborted: "已取消",
  queue_title: "队列",
  concurrency: "并行",
  concurrency_hint:
    "同时进行的生成数量。Pro（预览模型）建议设为 1：并行请求会耗尽较低的配额，导致全部因 429 卡住。",
  undo_send: "撤销发送（{n}）",
  undo_send_hint: "在倒计时内取消——请求尚未发送，不会计费。",
  cancel_running: "取消",
  cancel_running_hint:
    "完成当前这次尝试（成功则存入图库），然后停止重试。若这次尝试已生成完毕，可能仍会被计费。",
  undo_send_seconds: "发送延迟（秒）",
  undo_send_seconds_hint:
    "在真正调用 Vertex 前倒计时；窗口内取消 = 不计费。0 = 立即发送。",
  aborted_fallback: "已取消。",
  phase_delaying: "延迟发送中…",
  phase_queued: "排队中 · 等待空位",
  phase_sent: "已发送 · 第 {n} 次尝试",
  phase_retrying: "重试中（{code}）· 约 {n} 秒后",
  phase_running: "生成中…",
  phase_cancelling: "取消中 · 正在完成当前尝试（不再重试）",
  generation_waiting: "正在等待生成结果…",
  add_marker: "用当前颜色标记",
  remove_marker: "移除标记",
  choose_marker_color: "选择标记颜色",
  marker_red: "红色",
  marker_orange: "橙色",
  marker_yellow: "黄色",
  marker_green: "绿色",
  marker_blue: "蓝色",
  marker_purple: "紫色",
  marker_pink: "粉色",

  // Usage dashboard
  usage: "用量",
  usage_title: "用量",
  usage_range: "范围：{from} – {to}",
  usage_empty: "还没有生成记录。",
  stat_total: "生成次数",
  stat_success_rate: "成功率",
  stat_today: "今日",
  stat_last7: "近 7 天",
  stat_images: "图库图片",
  stat_storage: "已用存储",
  stat_tags: "标签",
  by_status_title: "按状态",
  by_model_title: "按模型",
  usage_series: "生成趋势",
  usage_period: "时段",
  usage_empty_period: "该范围内还没有生成记录。",
  bucket_day: "日",
  bucket_week: "周",
  bucket_month: "月",
  bucket_year: "年",
  bucket_all: "全部",
  cost_estimate: "预估花费",
  cost_estimate_note:
    "预估 · 按你设定的单价 · 仅统计成功。注意：被拦截的结果，以及已生成完毕后才取消的尝试，也可能被 Vertex 计费，这里未计入——因此这只是下限。应用无法看到你的真实账单。",
  cost_example_note: "这些是示例价格——请按你实际的 Vertex 费率调整。",
  cost_currency: "货币",
  cost_unit_price: "每张价格",
  cost_count: "成功次数",
  cost_subtotal: "小计",
  cost_total: "预估合计",
  clear_done: "清除已完成",
  remove_task: "移除",
  reuse: "复用",
  reuse_generate: "复用并立即生成",
  no_refs: "（无参考图）",
  no_output: "无输出",
  history_empty: "还没有生成记录。",

  // drafts
  new_draft: "新建草稿",
  edit_draft: "编辑草稿",
  save_draft: "保存草稿",
  save_draft_hint: "将当前提示词、图片和参数保存到草稿箱",
  draft_saved: "已保存到草稿箱",
  draft_editor_desc: "草稿不会调用 Vertex；输入图会用于将来的生成，输出图仅作为附件保存。",
  drafts_empty: "草稿箱是空的。可以保存当前编辑内容，或者从队列移入任务。",
  search_placeholder_drafts: "搜索草稿提示词…",
  draft_inputs: "输入",
  draft_outputs: "输出附件",
  draft_outputs_hint: "输出图片仅作为草稿附件，不会发送给模型。",
  draft_empty_prompt: "空提示词——点击编辑",
  edit_prompt_inline: "快速修改提示词",
  pin_draft: "置顶",
  unpin_draft: "取消置顶",
  queue_and_delete: "入队并删除",
  queue_and_keep: "入队并保留",
  save_copy_to_drafts: "保存副本到草稿箱",
  move_to_drafts: "移到草稿箱",
  draft_need_config: "请先配置 Vertex 项目，再将草稿放入队列。",
  draft_need_content: "草稿需要至少包含提示词或一张输入图片才能入队。",
  draft_deleted_input: "草稿包含已删除的输入图片；请先恢复或移除它。",
  draft_queued_kept: "已加入队列，草稿仍保留。",
  draft_queued_deleted: "已加入队列并删除草稿。",
  draft_queued_delete_failed: "任务已入队，但草稿删除失败：{msg}",
  confirm_delete_draft: "再次点击删除",

  // Backend reason codes (block reasons + HTTP statuses)
  reason_SAFETY: "被 Vertex AI 安全策略拦截（SAFETY）。",
  reason_IMAGE_SAFETY: "图片被安全策略拦截（IMAGE_SAFETY）。",
  reason_PROHIBITED_CONTENT: "被标记为违禁内容（PROHIBITED_CONTENT）。",
  reason_IMAGE_PROHIBITED_CONTENT:
    "图片被标记为违禁内容（IMAGE_PROHIBITED_CONTENT）。",
  reason_RECITATION:
    "因可能复述受版权保护的内容被拦截（RECITATION）。",
  reason_IMAGE_RECITATION:
    "图片因可能复述受版权保护的内容被拦截（IMAGE_RECITATION）。",
  reason_BLOCKLIST: "命中屏蔽词表（BLOCKLIST）。",
  reason_SPII: "可能涉及敏感个人信息（SPII）。",
  reason_IMAGE_OTHER: "因其他原因未生成图片（IMAGE_OTHER）。",
  reason_NO_IMAGE: "模型未生成图片（NO_IMAGE）。",
  reason_JAILBREAK: "请求被标记为越狱尝试（JAILBREAK）。",
  reason_MODEL_ARMOR: "被 Model Armor 策略拦截（MODEL_ARMOR）。",
  reason_400: "请求参数有误（400）。",
  reason_401: "凭据无效或未授权（401）。",
  reason_403: "权限被拒（403）：请确认账号具备 Vertex AI User 角色且已启用 aiplatform API。",
  reason_404: "模型不存在或在该区域不可用（404）。",
  reason_429: "已达配额 / 速率限制（429）。",

  add_history: "添加",
  add_history_title: "添加记录或草稿",
  add_history_desc:
    "把外部生成结果保存到历史，或创建一个稍后执行的任务草稿。",
  edit_history_title: "编辑历史记录",
  edit_history_desc: "编辑此记录的任意字段——提示词、图片、参数、状态或时间戳。",
  add_history_output: "输出图片",
  add_history_kind: "记录类型",
  add_history_status: "状态",
  duplicate: "复制",
  add_history_error_message: "错误信息",
  add_history_created_at: "创建时间（可选——留空则为当前时间）",
  add_history_need_output: "状态为“成功”时必须提供输出图片。",
  batch_output_hint:
    "将创建 {n} 条记录——每张输出图一条。备注与标签对全部生效。",
  pick_from_library: "从图库选取",
  note_no_output: "这是一条备注——没有输出图片。",

  skip_if_preceding_succeeds: "自动跳过",
  skip_if_preceding_succeeds_title: "若正在生成的任务成功则跳过此任务",
  skipped_by_preceding_success: "已跳过：前置任务已成功生成",
  attempts: "重试次数",
  attempts_hint:
    "一次提交排入 N 个相同任务：第一个按当前“自动跳过”设置，其余自动开启自动跳过——任意一次成功后，本组剩余任务自动跳过，不影响后续其它任务。",
};

const en: Dict = {
  tab_generate: "Generate",
  tab_library: "Library",
  tab_history: "History",
  tab_favorites: "Favorites",
  tab_drafts: "Drafts",
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
  hist_filter_with_image: "With image",
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
  load_error: "Failed to load: {msg}",
  retry: "Retry",
  lang_toggle: "Switch language",
  op_failed: "Action failed: {msg}",
  submit_shortcut_hint: "Cmd/Ctrl + Enter also submits",
  prev_page: "Prev",
  next_page: "Next",
  page_status: "Page {page}/{pages} · {total}",
  lib_empty: "The library is empty — upload some images on the Generate page.",
  tag_upload: "Uploaded",
  tag_generated: "Generated",
  toggle_source_hint: "Click to toggle Uploaded / Generated",
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
  status_draft: "Draft",
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
  generation_waiting: "Waiting for the generation result…",
  add_marker: "Mark with the current color",
  remove_marker: "Remove marker",
  choose_marker_color: "Choose marker color",
  marker_red: "Red",
  marker_orange: "Orange",
  marker_yellow: "Yellow",
  marker_green: "Green",
  marker_blue: "Blue",
  marker_purple: "Purple",
  marker_pink: "Pink",

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

  // drafts
  new_draft: "New draft",
  edit_draft: "Edit draft",
  save_draft: "Save draft",
  save_draft_hint: "Save the current prompt, images and settings to Drafts",
  draft_saved: "Saved to Drafts",
  draft_editor_desc: "Drafts never call Vertex. Inputs are used for future generation; outputs are attachments only.",
  drafts_empty: "No drafts yet. Save the composer or move a queued task here.",
  search_placeholder_drafts: "Search draft prompts…",
  draft_inputs: "Inputs",
  draft_outputs: "Output attachments",
  draft_outputs_hint: "Output images are draft attachments and are never sent to the model.",
  draft_empty_prompt: "Empty prompt — click to edit",
  edit_prompt_inline: "Quick-edit prompt",
  pin_draft: "Pin",
  unpin_draft: "Unpin",
  queue_and_delete: "Queue & delete",
  queue_and_keep: "Queue & keep",
  save_copy_to_drafts: "Save a copy to Drafts",
  move_to_drafts: "Move to Drafts",
  draft_need_config: "Set the Vertex project before queueing this draft.",
  draft_need_content: "A draft needs a prompt or at least one input image before it can be queued.",
  draft_deleted_input: "This draft contains a deleted input image. Restore or remove it first.",
  draft_queued_kept: "Queued; draft kept.",
  draft_queued_deleted: "Queued and draft deleted.",
  draft_queued_delete_failed: "Task queued, but the draft could not be deleted: {msg}",
  confirm_delete_draft: "Click again to delete",

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
  add_history_title: "Add record or draft",
  add_history_desc:
    "Save an external result into History, or create a task draft to run later.",
  edit_history_title: "Edit history record",
  edit_history_desc: "Edit any field of this record — prompt, images, params, status, or timestamp.",
  add_history_output: "Output image",
  add_history_kind: "Record type",
  add_history_status: "Status",
  duplicate: "Duplicate",
  add_history_error_message: "Error message",
  add_history_created_at: "Created at (optional — leave blank for now)",
  add_history_need_output: "An output image is required when status is Success.",
  batch_output_hint:
    "Creates {n} records — one per output image. Note & tags apply to all.",
  pick_from_library: "Pick from library",
  note_no_output: "This is a note — no output image.",

  skip_if_preceding_succeeds: "Auto-skip",
  skip_if_preceding_succeeds_title: "Skip if the running task succeeds",
  skipped_by_preceding_success: "Skipped: preceding task succeeded",
  attempts: "Tries",
  attempts_hint:
    "One submit enqueues N copies of this task: the first uses the Auto-skip toggle, the rest are auto-skip. The first success cancels the remaining copies of this task only — later tasks are unaffected.",
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
