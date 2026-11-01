import { filmTitleFor } from "./film-rank.util";

describe("filmTitleFor", () => {
  it.each([
    [0, "luyen_khi_so_ky"],
    [199, "luyen_khi_so_ky"],
    [200, "luyen_khi_trung_ky"],
    [400, "luyen_khi_hau_ky"],
    [800, "luyen_khi_dinh_phong"],
    [1_000, "truc_co_so_ky"],
    [1_800, "truc_co_trung_ky"],
    [5_000, "kim_dan_so_ky"],
    [50_000, "hoa_than_so_ky"],
    [200_000, "luyen_hu_so_ky"],
    [1_000_000, "luyen_hu_dinh_phong"],
  ])("maps %d EXP to %s", (exp, expectedTitle) => {
    expect(filmTitleFor(exp)).toBe(expectedTitle);
  });
});
