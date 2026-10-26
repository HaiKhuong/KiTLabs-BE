import { SectRank } from "./entities/film.entities";
import { filmRankFor } from "./film.service";

describe("filmRankFor", () => {
  it.each([
    [0, SectRank.LUYEN_KHI],
    [999, SectRank.LUYEN_KHI],
    [1000, SectRank.TRUC_CO],
    [5000, SectRank.KIM_DAN],
    [20000, SectRank.NGUYEN_ANH],
    [50000, SectRank.HOA_THAN],
    [200000, SectRank.LUAN_HOI],
    [1000000, SectRank.THAN_HOANG],
  ])("maps %i exp", (exp, rank) => expect(filmRankFor(exp as number)).toBe(rank));
});
