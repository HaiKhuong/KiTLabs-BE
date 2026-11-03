import { filmTitleFor } from "./film-rank.util";

describe("filmTitleFor", () => {
  it.each([
    [0, "luyen_khi_ky"],
    [199, "luyen_khi_ky"],
    [800, "luyen_khi_ky"],
    [1_000, "truc_co_ky"],
    [1_800, "truc_co_ky"],
    [5_000, "kim_dan_ky"],
    [20_000, "nguyen_anh_ky"],
    [50_000, "hoa_than_ky"],
    [200_000, "luyen_hu_ky"],
    [1_000_000, "luyen_hu_ky"],
  ])("maps %d EXP to %s", (exp, expectedTitle) => {
    expect(filmTitleFor(exp)).toBe(expectedTitle);
  });
});
