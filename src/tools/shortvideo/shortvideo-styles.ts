export const SHORT_VIDEO_STYLES = [
  { label: "Nhà Sinh Vật Học", value: "nha-sinh-vat-hoc" },
  { label: "Nhà Địa Lý", value: "nha-dia-ly" },
  { label: "Nhà Thám Hiểm", value: "nha-tham-hiem" },
  { label: "Nhà Thiên Văn Học", value: "nha-thien-van-hoc" },
  { label: "Nhà Cổ Sinh Vật Học", value: "nha-co-sinh-vat-hoc" },
  { label: "Nhà Khảo Cổ", value: "nha-khao-co" },
  { label: "Kiến Trúc Sư", value: "kien-truc-su" },
  { label: "Kỹ Sư", value: "ky-su" },
  { label: "Nhà Hóa Học", value: "nha-hoa-hoc" },
] as const;

export type ShortVideoStyle = (typeof SHORT_VIDEO_STYLES)[number]["value"];

export const DEFAULT_SHORT_VIDEO_STYLE: ShortVideoStyle = SHORT_VIDEO_STYLES[0].value;

const STYLE_VALUE_SET = new Set<string>(SHORT_VIDEO_STYLES.map((s) => s.value));

export function isShortVideoStyle(value: unknown): value is ShortVideoStyle {
  return typeof value === "string" && STYLE_VALUE_SET.has(value);
}
