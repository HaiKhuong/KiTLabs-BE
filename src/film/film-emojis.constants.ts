export const FILM_EMOJI_IDS = [
  "bai_phuc_01",
  "bai_phuc_02",
  "ban_tim_01",
  "ban_tim_02",
  "bi_bach_01",
  "bi_bach_02",
  "cam_dong_01",
  "cam_dong_02",
  "cam_on_01",
  "cam_on_02",
  "cay_phim_01",
  "chi_tay_cuoi_01",
  "chi_tay_cuoi_02",
  "dang_tai_01",
  "dang_tai_02",
  "dap_ban_02",
  "de_toi_01",
  "de_toi_02",
  "do_mo_hoi_01",
  "do_mo_hoi_02",
  "doi_nhe_02",
  "gian_doi_01",
  "gian_doi_02",
  "guc_nga_01",
  "guc_nga_02",
  "hong_phim_01",
  "hong_phim_02",
  "khoanh_tay_bo_02",
  "say_hi_01",
  "say_hi_02",
  "thang_cap_01",
  "thang_cap_02",
  "vay_tay_01",
  "vay_tay_02",
] as const;

const FILM_EMOJI_ID_SET = new Set<string>(FILM_EMOJI_IDS);

export function isFilmEmojiId(value: string) {
  return FILM_EMOJI_ID_SET.has(value);
}
