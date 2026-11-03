export interface FilmTitleItemSeed {
  slug: string;
  name: string;
  width: number;
  height: number;
  rank: string;
  minExp: number;
  nextExp: number;
  order: number;
}

export const FILM_TITLE_ITEM_SEED = [
  {
    slug: "luyen_khi_ky",
    name: "Luyện Khí Kỳ",
    width: 543,
    height: 181,
    rank: "LUYEN_KHI",
    minExp: 0,
    nextExp: 1_000,
    order: 1,
  },
  {
    slug: "truc_co_ky",
    name: "Trúc Cơ Kỳ",
    width: 543,
    height: 181,
    rank: "TRUC_CO",
    minExp: 1_000,
    nextExp: 5_000,
    order: 2,
  },
  {
    slug: "kim_dan_ky",
    name: "Kim Đan Kỳ",
    width: 543,
    height: 181,
    rank: "KIM_DAN",
    minExp: 5_000,
    nextExp: 20_000,
    order: 3,
  },
  {
    slug: "nguyen_anh_ky",
    name: "Nguyên Anh Kỳ",
    width: 543,
    height: 181,
    rank: "NGUYEN_ANH",
    minExp: 20_000,
    nextExp: 50_000,
    order: 4,
  },
  {
    slug: "hoa_than_ky",
    name: "Hóa Thần Kỳ",
    width: 543,
    height: 181,
    rank: "HOA_THAN",
    minExp: 50_000,
    nextExp: 200_000,
    order: 5,
  },
  {
    slug: "luyen_hu_ky",
    name: "Luyện Hư Kỳ",
    width: 543,
    height: 181,
    rank: "LUAN_HOI",
    minExp: 200_000,
    nextExp: 1_000_000,
    order: 6,
  },
  {
    slug: "tac_gia_canh",
    name: "Tác Giả Cảnh",
    width: 543,
    height: 181,
    rank: "THAN_HOANG",
    minExp: 1_000_000,
    nextExp: 1_000_000,
    order: 7,
  },
] as const satisfies readonly FilmTitleItemSeed[];
