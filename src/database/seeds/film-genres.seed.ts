export interface FilmGenreSeed {
  name: string;
  slug: string;
  badgeUrl: string;
  width: number;
  height: number;
  description: string;
}

export const FILM_GENRES_SEED: readonly FilmGenreSeed[] = [
  {
    name: "Trọng Sinh",
    slug: "trong-sinh",
    badgeUrl: "/effects/badge_trong_sinh.png",
    width: 534,
    height: 216,
    description: "Trọng sinh nghịch tập, trùng sinh kiếp trước cải biến vận mệnh",
  },
  {
    name: "Xuyên Không",
    slug: "xuyen-khong",
    badgeUrl: "/effects/badge_xuyen_khong.png",
    width: 543,
    height: 238,
    description: "Xuyên việt vạn giới, dị bản giang hồ, đưa hiện đại vào cổ đại",
  },
  {
    name: "Hệ Thống",
    slug: "he-thong",
    badgeUrl: "/effects/badge_he_thong.png",
    width: 541,
    height: 236,
    description: "Nhận hệ thống thần cấp, bàn tay vàng nghịch thiên",
  },
  {
    name: "Vô Địch Lưu",
    slug: "vo-dich-luu",
    badgeUrl: "/effects/badge_vo_dich_luu.png",
    width: 530,
    height: 236,
    description: "Nhân vật chính vô địch thiên hạ, nghiền ép đối thủ",
  },
  {
    name: "Giấu Nghề",
    slug: "giau-nghe",
    badgeUrl: "/effects/badge_giau_nghe.png",
    width: 532,
    height: 240,
    description: "Đại năng ẩn dật giả heo ăn hổ, ẩn tàng thực lực chấn kinh vạn giới",
  },
  {
    name: "Phản Diện Lưu",
    slug: "phan-dien-luu",
    badgeUrl: "/effects/badge_phan_dien_luu.png",
    width: 541,
    height: 240,
    description: "Nhân vật chính là ma đầu hoặc phản diện mưu lược sắc sảo",
  },
  {
    name: "Dị Thú Tiến Hóa",
    slug: "di-thu-tien-hoa",
    badgeUrl: "/effects/badge_di_thu_tien_hoa.png",
    width: 552,
    height: 241,
    description: "Tu luyện tiến hóa dị thú thần thoại, cự thú viễn cổ",
  },
  {
    name: "Phế Vật Nghịch Thiên",
    slug: "phe-vat-nghich-thien",
    badgeUrl: "/effects/badge_phe_vat_nghich_thien.png",
    width: 534,
    height: 238,
    description: "Từ phế sài quật khởi, nghịch tập vả mặt thiên kiêu",
  },
  {
    name: "Mạt Thế",
    slug: "mat-the",
    badgeUrl: "/effects/badge_mat_the.png",
    width: 534,
    height: 225,
    description: "Sinh tồn thế giới tận thế, zombie, quái vật, biến dị",
  },
  {
    name: "Trò Chơi Hoá",
    slug: "tro-choi-hoa",
    badgeUrl: "/effects/badge_tro_choi_hoa.png",
    width: 545,
    height: 232,
    description: "Thế giới số hóa trò chơi, phó bản, nâng cấp trang bị",
  },
  {
    name: "Ma Đạo / Tà Tu",
    slug: "ma-dao-ta-tu",
    badgeUrl: "/effects/badge_ma_dao_ta_tu.png",
    width: 545,
    height: 223,
    description: "Ma tu tà phái, công pháp ma đạo nghịch thiên",
  },
  {
    name: "Nữ Cường",
    slug: "nu-cuong",
    badgeUrl: "/effects/badge_nu_cuong.png",
    width: 554,
    height: 225,
    description: "Nữ chính mạnh mẽ, độc lập, sát phạt quyết đoán",
  },
  {
    name: "Tây Du",
    slug: "tay-du",
    badgeUrl: "/effects/badge_tay_du.png",
    width: 526,
    height: 219,
    description: "Dị bản Tây Du Ký, thầy trò Đường Tăng nghịch thiên",
  },
  {
    name: "Hài Hước",
    slug: "hai-huoc",
    badgeUrl: "/effects/badge_hai_huoc.png",
    width: 545,
    height: 216,
    description: "Tình tiết hài hước hóm hỉnh, sảng văn vui nhộn",
  },
  {
    name: "Sát Phạt",
    slug: "sat-phat",
    badgeUrl: "/effects/badge_sat_phat.png",
    width: 541,
    height: 223,
    description: "Sát phạt quyết đoán, không thánh mẫu, ân oán phân minh",
  },
  {
    name: "Hậu Cung",
    slug: "hau-cung",
    badgeUrl: "/effects/badge_hau_cung.png",
    width: 551,
    height: 222,
    description: "Nhiều hồng nhan tri kỷ, giai nhân tuyệt sắc đồng hành",
  },
] as const;

