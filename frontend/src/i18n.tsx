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
  clear_sel: "清空选择",

  status_success: "成功",
  status_blocked: "被拦截",
  status_error: "出错",
  status_pending: "排队中",
  status_running: "生成中",
  queue_title: "队列",
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
  clear_sel: "Clear",

  status_success: "Success",
  status_blocked: "Blocked",
  status_error: "Error",
  status_pending: "Queued",
  status_running: "Generating",
  queue_title: "Queue",
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
