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

const CULTIVATION_TITLE_RANKS = [
  { slug: "luyen_khi", minExp: 0, nextExp: 1_000 },
  { slug: "truc_co", minExp: 1_000, nextExp: 5_000 },
  { slug: "kim_dan", minExp: 5_000, nextExp: 20_000 },
  { slug: "nguyen_anh", minExp: 20_000, nextExp: 50_000 },
  { slug: "hoa_than", minExp: 50_000, nextExp: 200_000 },
  { slug: "luyen_hu", minExp: 200_000, nextExp: 1_000_000 },
] as const;

const CULTIVATION_TITLE_STAGES = [
  { slug: "so_ky", startRatio: 0 },
  { slug: "trung_ky", startRatio: 0.2 },
  { slug: "hau_ky", startRatio: 0.4 },
  { slug: "dinh_phong", startRatio: 0.8 },
] as const;

/** Returns the highest cultivation title unlocked by the supplied EXP. */
export const filmTitleFor = (exp: number): string => {
  const normalizedExp = Number.isFinite(exp) ? Math.max(0, Math.floor(exp)) : 0;
  const rank =
    CULTIVATION_TITLE_RANKS.find(({ nextExp }) => normalizedExp < nextExp) ??
    CULTIVATION_TITLE_RANKS[CULTIVATION_TITLE_RANKS.length - 1];
  const rankSpan = rank.nextExp - rank.minExp;
  const rankRatio = Math.min(Math.max(normalizedExp - rank.minExp, 0), rankSpan) / rankSpan;
  const stage =
    [...CULTIVATION_TITLE_STAGES]
      .reverse()
      .find(({ startRatio }) => rankRatio >= startRatio) ?? CULTIVATION_TITLE_STAGES[0];

  return `${rank.slug}_${stage.slug}`;
};

