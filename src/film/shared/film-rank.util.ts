import { SectRank } from "../entities/film.entities";

export const filmRankFor = (exp: number): SectRank => {
  if (exp >= 1_000_000) return SectRank.THAN_HOANG;
  if (exp >= 200_000) return SectRank.LUAN_HOI;
  if (exp >= 50_000) return SectRank.HOA_THAN;
  if (exp >= 20_000) return SectRank.NGUYEN_ANH;
  if (exp >= 5_000) return SectRank.KIM_DAN;
  if (exp >= 1_000) return SectRank.TRUC_CO;
  return SectRank.LUYEN_KHI;
};

