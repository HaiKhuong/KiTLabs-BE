import {
  extractMovieCleanTitle,
  extractSeasonOrEpisodeLabel,
  normalizeMovieTitle,
  parseSeasonNumber,
  parseVideoMovieInfo,
} from "./facebook.service";

describe("Facebook Video Regex Extraction", () => {
  it("should extract Season label correctly from Vietnamese and English prefixes", () => {
    expect(
      extractSeasonOrEpisodeLabel("Mùa 2 | Xuyên Không Thành Yêu Tộc - Ta Tự Chế Tạo Hệ Thống AI"),
    ).toBe("Mùa 2");

    expect(extractSeasonOrEpisodeLabel("Season 3: Huyết Chiến")).toBe("Mùa 3");

    expect(extractSeasonOrEpisodeLabel("Phần 1 | Cuồng Long")).toBe("Phần 1");

    expect(extractSeasonOrEpisodeLabel("Tập 15 - Đại Thần Quy Lai")).toBe("Tập 15");

    expect(extractSeasonOrEpisodeLabel("Phim lẻ không có mùa")).toBe("");

    expect(
      extractSeasonOrEpisodeLabel("[16+] Mùa 6 | Toàn Dân Chuyển Chức: Thức Tỉnh Cung Thủ Sát Thương Tích Lũy Vô Hạn"),
    ).toBe("Mùa 6");
  });

  it("should clean movie title by stripping Season/Episode and tags", () => {
    expect(
      extractMovieCleanTitle("Mùa 2 | Xuyên Không Thành Yêu Tộc - Ta Tự Chế Tạo Hệ Thống AI"),
    ).toBe("Xuyên Không Thành Yêu Tộc - Ta Tự Chế Tạo Hệ Thống AI");

    expect(extractMovieCleanTitle("Season 3: Huyết Chiến")).toBe("Huyết Chiến");

    expect(extractMovieCleanTitle("Phần 1 - Cuồng Long")).toBe("Cuồng Long");

    expect(extractMovieCleanTitle("Tập 5 | Thôn Phệ Tinh Không")).toBe("Thôn Phệ Tinh Không");

    expect(extractMovieCleanTitle("Tuyệt Thế Võ Thần")).toBe("Tuyệt Thế Võ Thần");

    expect(
      extractMovieCleanTitle("[16+] Mùa 6 | Toàn Dân Chuyển Chức: Thức Tỉnh Cung Thủ Sát Thương Tích Lũy Vô Hạn"),
    ).toBe("Toàn Dân Chuyển Chức: Thức Tỉnh Cung Thủ Sát Thương Tích Lũy Vô Hạn");

    expect(
      extractMovieCleanTitle("[16+] Mùa 1 - Toàn Dân Chuyển Chức: Ta Được Hệ Thống Thần Tài Có Tiền Sai Được Quỷ Thần"),
    ).toBe("Toàn Dân Chuyển Chức: Ta Được Hệ Thống Thần Tài Có Tiền Sai Được Quỷ Thần");
  });

  it("should extract info from description if title is generic", () => {
    const desc = `[16+] Mùa 6 | Toàn Dân Chuyển Chức: Thức Tỉnh Cung Thủ Sát Thương Tích Lũy Vô Hạn\n\n💖 ĐỪNG QUÊN ỦNG HỘ RỒNG CON NHÉ!`;
    const info = parseVideoMovieInfo("Video", desc);
    expect(info.seasonLabel).toBe("Mùa 6");
    expect(info.movieTitle).toBe("Toàn Dân Chuyển Chức: Thức Tỉnh Cung Thủ Sát Thương Tích Lũy Vô Hạn");
    expect(normalizeMovieTitle(info.movieTitle)).toBe("toàn dân chuyển chức thức tỉnh cung thủ sát thương tích lũy vô hạn");
  });

  it("should correctly sort seasons", () => {
    const list = ["Mùa 5", "Mùa 1", "Mùa 6", "Mùa 4 P2", "Mùa 4", "Mùa 2"];
    const sorted = [...list].sort((a, b) => parseSeasonNumber(a) - parseSeasonNumber(b));
    expect(sorted).toEqual(["Mùa 1", "Mùa 2", "Mùa 4", "Mùa 4 P2", "Mùa 5", "Mùa 6"]);
  });
});

