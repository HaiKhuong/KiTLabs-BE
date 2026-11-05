import { DataSource, EntityManager } from "typeorm";
import { FilmItem, FilmSetting, ItemType, SectRank } from "../entities/film.entities";

export const CULTIVATION_RANKS_SETTING_KEY = "CULTIVATION_RANKS";

export interface CultivationRankConfig {
  rank: SectRank;
  slug: string;
  label: string;
  minExp: number;
  nextExp: number;
}

export const DEFAULT_CULTIVATION_RANKS: readonly CultivationRankConfig[] = [
  { rank: SectRank.LUYEN_KHI, slug: "luyen_khi_ky", label: "Luyện Khí Kỳ", minExp: 0, nextExp: 1_000 },
  { rank: SectRank.TRUC_CO, slug: "truc_co_ky", label: "Trúc Cơ Kỳ", minExp: 1_000, nextExp: 5_000 },
  { rank: SectRank.KIM_DAN, slug: "kim_dan_ky", label: "Kim Đan Kỳ", minExp: 5_000, nextExp: 20_000 },
  { rank: SectRank.NGUYEN_ANH, slug: "nguyen_anh_ky", label: "Nguyên Anh Kỳ", minExp: 20_000, nextExp: 50_000 },
  { rank: SectRank.HOA_THAN, slug: "hoa_than_ky", label: "Hóa Thần Kỳ", minExp: 50_000, nextExp: 200_000 },
  { rank: SectRank.LUAN_HOI, slug: "luyen_hu_ky", label: "Luyện Hư Kỳ", minExp: 200_000, nextExp: 1_000_000 },
  { rank: SectRank.THAN_HOANG, slug: "tac_gia_canh", label: "Tác Giả Cảnh", minExp: 999_999, nextExp: 1_000_000 },
] as const;

export function normalizeTitleSlug(slug: string | null | undefined): string | null {
  if (!slug || typeof slug !== "string") return null;
  if (slug === "tac_gia_canh") return "tac_gia_canh";
  if (slug.startsWith("luyen_khi_")) return "luyen_khi_ky";
  if (slug.startsWith("truc_co_")) return "truc_co_ky";
  if (slug.startsWith("kim_dan_")) return "kim_dan_ky";
  if (slug.startsWith("nguyen_anh_")) return "nguyen_anh_ky";
  if (slug.startsWith("hoa_than_")) return "hoa_than_ky";
  if (slug.startsWith("luyen_hu_")) return "luyen_hu_ky";
  return slug;
}

export async function resolveCultivationRanks(
  dbOrManager?: DataSource | EntityManager | null,
): Promise<readonly CultivationRankConfig[]> {
  if (!dbOrManager) return DEFAULT_CULTIVATION_RANKS;

  try {
    const settingRepo = dbOrManager.getRepository(FilmSetting);
    const setting = await settingRepo.findOne({
      where: { key: CULTIVATION_RANKS_SETTING_KEY },
    });
    const rawRanks = Array.isArray(setting?.value)
      ? setting.value
      : Array.isArray(setting?.value?.ranks)
        ? setting.value.ranks
        : null;

    if (rawRanks && rawRanks.length > 0) {
      const parsed: CultivationRankConfig[] = rawRanks
        .map((item: any) => ({
          rank: (item?.rank as SectRank) || SectRank.LUYEN_KHI,
          slug: normalizeTitleSlug(String(item?.slug || "")) || "luyen_khi_ky",
          label: String(item?.label || item?.name || ""),
          minExp: Number(item?.minExp ?? 0),
          nextExp: Number(item?.nextExp ?? 0),
        }))
        .filter((item: CultivationRankConfig) => item.nextExp > item.minExp && Boolean(item.slug))
        .sort((a: CultivationRankConfig, b: CultivationRankConfig) => a.minExp - b.minExp);

      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Ignore when FilmSetting repository is unavailable (e.g., unit test mocks)
  }

  try {
    const itemRepo = dbOrManager.getRepository(FilmItem);
    const titleItems = await itemRepo.find({ where: { type: ItemType.TITLE } });
    const fromItems: CultivationRankConfig[] = titleItems
      .map((item) => {
        const cfg = (item.assetConfig || {}) as Record<string, any>;
        const slug = normalizeTitleSlug(String(cfg.slug || ""));
        const minExp = Number(cfg.minExp);
        const nextExp = Number(cfg.nextExp);
        if (!slug || !Number.isFinite(minExp) || !Number.isFinite(nextExp) || nextExp <= minExp) {
          return null;
        }
        return {
          rank: (cfg.rank as SectRank) || SectRank.LUYEN_KHI,
          slug,
          label: item.name || slug,
          minExp,
          nextExp,
        };
      })
      .filter((item): item is CultivationRankConfig => item !== null)
      .sort((a, b) => a.minExp - b.minExp);

    if (fromItems.length > 0) return fromItems;
  } catch {
    // Ignore when FilmItem repository is unavailable
  }

  return DEFAULT_CULTIVATION_RANKS;
}

export const filmRankFor = (
  exp: number,
  ranks: readonly CultivationRankConfig[] = DEFAULT_CULTIVATION_RANKS,
): SectRank => {
  const normalizedExp = Number.isFinite(exp) ? Math.max(0, Math.floor(exp)) : 0;
  const maxThreshold = ranks[ranks.length - 1]?.nextExp ?? 1_000_000;
  if (normalizedExp >= maxThreshold) return SectRank.THAN_HOANG;
  const matched = ranks.find(({ nextExp }) => normalizedExp < nextExp) ?? ranks[ranks.length - 1];
  return matched ? matched.rank : SectRank.LUYEN_KHI;
};

/** Returns the highest cultivation title unlocked by the supplied EXP. */
export const filmTitleFor = (
  exp: number,
  ranks: readonly CultivationRankConfig[] = DEFAULT_CULTIVATION_RANKS,
): string => {
  const normalizedExp = Number.isFinite(exp) ? Math.max(0, Math.floor(exp)) : 0;
  const automaticRanks = ranks.filter(({ slug }) => slug !== "tac_gia_canh");
  const rank =
    automaticRanks.find(({ nextExp }) => normalizedExp < nextExp) ??
    automaticRanks[automaticRanks.length - 1];

  return rank?.slug ?? "luyen_khi_ky";
};

export interface FilmCultivationProgress {
  currentTitle: string;
  nextTitle: string;
  nextTitleLabel: string;
  minExp: number;
  nextExp: number;
  expPercentage: number;
}

export function buildCultivationProgress(
  expInput: number | string | null | undefined,
  equippedTitle?: string | null,
  ranks: readonly CultivationRankConfig[] = DEFAULT_CULTIVATION_RANKS,
): FilmCultivationProgress {
  const parsedExp = typeof expInput === "number" ? expInput : Number(expInput ?? 0);
  const exp = Number.isFinite(parsedExp) ? Math.max(0, Math.floor(parsedExp)) : 0;

  const matchedRankIndex = ranks.findIndex(({ nextExp }) => exp < nextExp);
  const rankIndex = matchedRankIndex === -1 ? ranks.length - 1 : matchedRankIndex;

  const normalizedEquipped = normalizeTitleSlug(equippedTitle);
  const equippedRankIndex = normalizedEquipped
    ? ranks.findIndex(({ slug }) => slug === normalizedEquipped)
    : -1;

  const displayedRankIndex = equippedRankIndex >= 0 ? equippedRankIndex : rankIndex;
  const displayedRank = ranks[displayedRankIndex] ?? DEFAULT_CULTIVATION_RANKS[0];
  const nextRank =
    displayedRankIndex < ranks.length - 1
      ? ranks[displayedRankIndex + 1]
      : displayedRank;

  const minExp = displayedRank.minExp;
  const nextExp = displayedRank.nextExp;
  const span = nextExp - minExp;
  const progress = Math.min(Math.max(exp - minExp, 0), span);
  const expPercentage = span > 0 ? Math.round(((progress / span) * 100) * 100) / 100 : 100;

  return {
    currentTitle: normalizedEquipped ?? displayedRank.slug,
    nextTitle: nextRank.slug,
    nextTitleLabel: nextRank.label,
    minExp,
    nextExp,
    expPercentage,
  };
}
