export type DesktopMenuGroup = "primary" | "more-tools";

export type DesktopMenuCatalogItem = {
  key: string;
  label: string;
  group: DesktopMenuGroup;
  category: "ai" | "basic";
};

export const DESKTOP_MENU_CATALOG: DesktopMenuCatalogItem[] = [
  { key: "media", label: "Media (Dịch & Render)", group: "primary", category: "ai" },
  { key: "voice", label: "Voice (TTS)", group: "primary", category: "ai" },
  { key: "recap", label: "Recap", group: "primary", category: "ai" },
  { key: "queues", label: "Queues", group: "primary", category: "basic" },
  { key: "download", label: "Download", group: "primary", category: "basic" },
  { key: "histories", label: "Histories", group: "primary", category: "basic" },
  { key: "tiktok", label: "TikTok", group: "more-tools", category: "basic" },
  { key: "facebook", label: "Facebook", group: "more-tools", category: "basic" },
  { key: "workflow", label: "Workflow", group: "more-tools", category: "ai" },
  { key: "text2image", label: "Image", group: "more-tools", category: "ai" },
  { key: "text2video", label: "Video", group: "more-tools", category: "ai" },
  { key: "short-video", label: "Short Video", group: "more-tools", category: "ai" },
  { key: "image-cutout", label: "Tách object", group: "more-tools", category: "ai" },
  { key: "image-remove-bg", label: "Tách nền", group: "more-tools", category: "ai" },
  { key: "image-upscale", label: "Upscale", group: "more-tools", category: "ai" },
  { key: "whiteboard", label: "Whiteboard", group: "more-tools", category: "ai" },
  { key: "compare-subtitle", label: "Compare Srt", group: "more-tools", category: "basic" },
  { key: "youtube", label: "YouTube", group: "more-tools", category: "basic" },
];

const VALID_MENU_KEYS = new Set(DESKTOP_MENU_CATALOG.map((item) => item.key));

export function normalizeAllowedMenus(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const entry of raw) {
    const key = String(entry || "").trim();
    if (key && VALID_MENU_KEYS.has(key)) {
      unique.add(key);
    }
  }
  return Array.from(unique);
}
