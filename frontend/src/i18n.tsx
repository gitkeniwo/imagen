import { createContext, useContext, useState, ReactNode } from "react";

export type Lang = "zh" | "en";

type Dict = Record<string, string>;

const zh: Dict = {
  tab_generate: "生成",
  tab_library: "图库",
  tab_history: "历史",
  settings: "设置",
  set_api_key: "设置 Vertex",
  resize_sidebar: "拖拽调整侧栏宽度，双击重置",
  no_key_warning: "尚未设置 Vertex 项目。点击右上角「设置 Vertex」填入 Project ID 后即可生成。",

  settings_title: "Vertex AI 设置（ADC）",
  settings_desc:
    "本 App 使用 ADC（Application Default Credentials）鉴权，不保存任何密钥；这里只存非敏感的 Project ID 与 Location。",
  settings_project: "Project ID",
  settings_location: "Location（区域）",
  settings_adc_hint:
    "前提：本机已运行 `gcloud auth application-default login` 并 `... set-quota-project <项目ID>`，且账号有 Vertex AI User 角色、项目已启用 aiplatform API。Location 一般填 global。",
  cancel: "取消",
  save: "保存",
  saving: "保存中…",
  show_more: "展开",
  show_less: "收起",

  tray_label: "参考图片（上传新图或从图库引用，顺序可拖拽调整）",
  tray_upload: "＋ 拖拽/点击上传",
  tray_drop_title: "松开即可上传图片",
  tray_drop_hint: "图片会加入当前参考图列表",

  prompt: "Prompt",
  prompt_placeholder: "描述你想要的编辑/生成，例如：把这三张产品图合成一张暖色调的海报…",
  model: "模型",
  aspect: "比例",
  resolution: "清晰度",
  format: "输出格式",
  pro_only: "（仅 Pro 支持）",
  generate: "生成",
  generating: "生成中…",
  ref_count: "{n} 张参考图",
  need_key_inline: " · 请先设置 Vertex 项目",

  gen_success: "生成成功",
  use_as_ref: "作为参考继续编辑",
  download: "下载",
  blocked_title: "被安全策略拦截",
  error_title: "出错",
  blocked_fallback: "结果被 Google 拦截。",
  error_fallback: "生成失败。",

  filter_all: "全部",
  filter_upload: "上传",
  filter_generated: "生成",
  lib_hint: "点击图片即可加入参考",
  columns_per_row: "每行",
  density: "列密度",
  fullscreen_manage: "全屏管理",
  thumb_size: "缩略图大小",
  tab_bin: "回收站",
  bin_title: "回收站",
  bin_hint: "已删除的图片会保留在这里，可恢复或彻底删除。",
  bin_empty_state: "回收站是空的。",
  restore: "恢复",
  delete_forever: "彻底删除",
  empty_bin: "清空回收站",
  deleted_label: "已删除",
  confirm_delete: "把这张图片移入回收站？",
  confirm_purge: "彻底删除这张图片？此操作不可恢复。",
  confirm_empty_bin: "清空回收站？所有图片将被永久删除，不可恢复。",
  search_placeholder_library: "搜索文件名 / tag…",
  search_placeholder_history: "搜索 prompt…",
  clear_search: "清除搜索",
  no_results: "没有匹配的结果",
  clear_filters: "清除筛选",
  loading: "加载中…",
  prev_page: "上一页",
  next_page: "下一页",
  page_status: "第 {page}/{pages} 页 · {total} 条",
  lib_empty: "图库还是空的，去「生成」页上传一些图片吧。",
  tag_upload: "上传",
  tag_generated: "生成",
  star: "收藏",
  delete: "删除",
  add_ref: "加入参考",
  open_viewer: "查看大图",

  // tags
  no_tags: "还没有 tag",
  new_tag_placeholder: "新建 tag…",
  create: "创建",
  tags_label: "标签",
  tags_all: "全部",
  add_to_input: "加入输入",
  close: "关闭",
  archive_to: "归档到 tag（生成后自动加入：输出图 + 本次输入图）",
  select_mode: "多选",
  done: "完成",
  selected_n: "已选 {n}",
  batch_add_tag: "批量加 tag",
  batch_remove_tag: "批量移 tag",
  batch_download: "下载",
  clear_sel: "清空选择",
  select_all: "全选本页",
  deselect_all: "取消全选",
  apply_to_selected: "应用到已选",
  create_new_tag: "新建并应用",

  status_success: "成功",
  status_blocked: "被拦截",
  status_error: "出错",
  status_pending: "排队中",
  status_running: "生成中",
  status_cancelling: "取消中",
  status_aborted: "已取消",
  queue_title: "队列",
  concurrency: "并发",
  concurrency_hint:
    "同时发起的生成数。跑 Pro（preview 模型）建议设为 1：并发会互相挤占低配额导致都卡 429。",
  undo_send: "撤销发送 ({n})",
  undo_send_hint: "倒计时内取消，请求尚未发出，保证不计费。",
  cancel_running: "取消",
  cancel_running_hint:
    "做完当前这次（成功则存入图库）后停止重试。进行中的这次若已生成完成仍会计费。",
  undo_send_seconds: "发送延迟（秒）",
  undo_send_seconds_hint:
    "提交后先倒计时再真正调用 Vertex；窗口内取消 = 不计费。填 0 表示立即发送。",
  aborted_fallback: "已取消。",
  phase_delaying: "延迟发送中…",
  phase_queued: "排队中 · 等待空位",
  phase_sent: "已发送 · 第 {n} 次尝试",
  phase_retrying: "重试中（{code}）· 约 {n}s 后",
  phase_running: "生成中…",
  phase_cancelling: "取消中 · 收尾当前这次（不再重试）",

  // Usage dashboard
  usage: "用量",
  usage_title: "用量统计",
  usage_range: "数据范围：{from} – {to}",
  usage_empty: "还没有任何生成记录。",
  stat_total: "总生成",
  stat_success_rate: "成功率",
  stat_today: "今日",
  stat_last7: "近 7 天",
  stat_images: "图库图片",
  stat_storage: "占用存储",
  stat_tags: "标签",
  by_status_title: "状态分布",
  by_model_title: "模型分布",
  usage_series: "生成量趋势",
  usage_period: "统计范围",
  usage_empty_period: "该范围内还没有生成记录。",
  bucket_day: "日",
  bucket_week: "周",
  bucket_month: "月",
  bucket_year: "年",
  bucket_all: "全部",
  cost_estimate: "花费估算",
  cost_estimate_note:
    "估算 · 按你设的单价 · 仅计成功生成。注意：被拦截（blocked）、以及已生成完成后才取消的那次也可能被 Vertex 计费，此处未计入，属下限估计。本 App 看不到真实账单。",
  cost_example_note: "以下为示例单价，请按你在 Vertex 的实际计费核对修改。",
  cost_currency: "货币符号",
  cost_unit_price: "单价 / 张",
  cost_count: "成功",
  cost_subtotal: "小计",
  cost_total: "估算合计",
  clear_done: "清除已完成",
  remove_task: "移除",
  reuse: "复用",
  no_refs: "（无参考图）",
  no_output: "无输出",
  history_empty: "还没有生成记录。",

  // Backend reason codes (block reasons + HTTP statuses)
  reason_SAFETY: "结果被 Vertex AI 安全策略拦截（SAFETY）。",
  reason_IMAGE_SAFETY: "图像被安全策略拦截（IMAGE_SAFETY）。",
  reason_PROHIBITED_CONTENT: "内容被判定为禁止内容（PROHIBITED_CONTENT）。",
  reason_IMAGE_PROHIBITED_CONTENT: "图像被判定为禁止内容（IMAGE_PROHIBITED_CONTENT）。",
  reason_RECITATION: "结果因疑似复述受版权保护内容被拦截（RECITATION）。",
  reason_IMAGE_RECITATION: "图像因疑似复述受版权保护内容被拦截（IMAGE_RECITATION）。",
  reason_BLOCKLIST: "命中屏蔽词表（BLOCKLIST）。",
  reason_SPII: "疑似涉及敏感个人信息（SPII）。",
  reason_IMAGE_OTHER: "图像因其它原因未生成（IMAGE_OTHER）。",
  reason_NO_IMAGE: "模型未生成图像（NO_IMAGE）。",
  reason_JAILBREAK: "请求被判定为越狱尝试（JAILBREAK）。",
  reason_MODEL_ARMOR: "被 Model Armor 策略拦截（MODEL_ARMOR）。",
  reason_400: "请求参数有误（400）。",
  reason_401: "凭据无效或未授权（401）。",
  reason_403: "无权限或被拒绝（403）：请确认账号有 Vertex AI User 角色、项目已启用 aiplatform API。",
  reason_404: "模型不存在或该区域不可用（404）。",
  reason_429: "触发配额/限流（429）。",
};

const en: Dict = {
  tab_generate: "Generate",
  tab_library: "Library",
  tab_history: "History",
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
