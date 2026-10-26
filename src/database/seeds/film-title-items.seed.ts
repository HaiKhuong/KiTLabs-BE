export interface FilmTitleItemSeed {
  slug: string;
  name: string;
  width: number;
  height: number;
}

export const FILM_TITLE_ITEM_SEED = [
  { slug: "luyen_khi_so_ky", name: "Luyện Khí - Sơ Kỳ", width: 495, height: 91 },
  { slug: "luyen_khi_trung_ky", name: "Luyện Khí - Trung Kỳ", width: 511, height: 94 },
  { slug: "luyen_khi_hau_ky", name: "Luyện Khí - Hậu Kỳ", width: 518, height: 125 },
  { slug: "luyen_khi_dinh_phong", name: "Luyện Khí - Đỉnh Phong", width: 530, height: 187 },
  { slug: "truc_co_so_ky", name: "Trúc Cơ - Sơ Kỳ", width: 503, height: 95 },
  { slug: "truc_co_trung_ky", name: "Trúc Cơ - Trung Kỳ", width: 520, height: 110 },
  { slug: "truc_co_hau_ky", name: "Trúc Cơ - Hậu Kỳ", width: 527, height: 142 },
  { slug: "truc_co_dinh_phong", name: "Trúc Cơ - Đỉnh Phong", width: 535, height: 176 },
  { slug: "kim_dan_so_ky", name: "Kim Đan - Sơ Kỳ", width: 517, height: 114 },
  { slug: "kim_dan_trung_ky", name: "Kim Đan - Trung Kỳ", width: 531, height: 124 },
  { slug: "kim_dan_hau_ky", name: "Kim Đan - Hậu Kỳ", width: 531, height: 169 },
  { slug: "kim_dan_dinh_phong", name: "Kim Đan - Đỉnh Phong", width: 539, height: 207 },
  { slug: "nguyen_anh_so_ky", name: "Nguyên Anh - Sơ Kỳ", width: 515, height: 116 },
  { slug: "nguyen_anh_trung_ky", name: "Nguyên Anh - Trung Kỳ", width: 527, height: 128 },
  { slug: "nguyen_anh_hau_ky", name: "Nguyên Anh - Hậu Kỳ", width: 528, height: 170 },
  { slug: "nguyen_anh_dinh_phong", name: "Nguyên Anh - Đỉnh Phong", width: 538, height: 211 },
  { slug: "hoa_than_so_ky", name: "Hóa Thần - Sơ Kỳ", width: 517, height: 119 },
  { slug: "hoa_than_trung_ky", name: "Hóa Thần - Trung Kỳ", width: 531, height: 133 },
  { slug: "hoa_than_hau_ky", name: "Hóa Thần - Hậu Kỳ", width: 532, height: 179 },
  { slug: "hoa_than_dinh_phong", name: "Hóa Thần - Đỉnh Phong", width: 541, height: 208 },
  { slug: "luyen_hu_so_ky", name: "Luyện Hư - Sơ Kỳ", width: 506, height: 122 },
  { slug: "luyen_hu_trung_ky", name: "Luyện Hư - Trung Kỳ", width: 524, height: 138 },
  { slug: "luyen_hu_hau_ky", name: "Luyện Hư - Hậu Kỳ", width: 527, height: 180 },
  { slug: "luyen_hu_dinh_phong", name: "Luyện Hư - Đỉnh Phong", width: 537, height: 206 },
  { slug: "tac_gia_canh", name: "Tác Giả Cảnh", width: 543, height: 181 },
] as const satisfies readonly FilmTitleItemSeed[];
