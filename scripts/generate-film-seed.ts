import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";

export interface FilmTitleItemSeed {
  slug: string;
  name: string;
  width: number;
  height: number;
}

const TITLE_LABELS: Record<string, string> = {
  luyen_khi_so_ky: "Luyện Khí - Sơ Kỳ",
  luyen_khi_trung_ky: "Luyện Khí - Trung Kỳ",
  luyen_khi_hau_ky: "Luyện Khí - Hậu Kỳ",
  luyen_khi_dinh_phong: "Luyện Khí - Đỉnh Phong",
  truc_co_so_ky: "Trúc Cơ - Sơ Kỳ",
  truc_co_trung_ky: "Trúc Cơ - Trung Kỳ",
  truc_co_hau_ky: "Trúc Cơ - Hậu Kỳ",
  truc_co_dinh_phong: "Trúc Cơ - Đỉnh Phong",
  kim_dan_so_ky: "Kim Đan - Sơ Kỳ",
  kim_dan_trung_ky: "Kim Đan - Trung Kỳ",
  kim_dan_hau_ky: "Kim Đan - Hậu Kỳ",
  kim_dan_dinh_phong: "Kim Đan - Đỉnh Phong",
  nguyen_anh_so_ky: "Nguyên Anh - Sơ Kỳ",
  nguyen_anh_trung_ky: "Nguyên Anh - Trung Kỳ",
  nguyen_anh_hau_ky: "Nguyên Anh - Hậu Kỳ",
  nguyen_anh_dinh_phong: "Nguyên Anh - Đỉnh Phong",
  hoa_than_so_ky: "Hóa Thần - Sơ Kỳ",
  hoa_than_trung_ky: "Hóa Thần - Trung Kỳ",
  hoa_than_hau_ky: "Hóa Thần - Hậu Kỳ",
  hoa_than_dinh_phong: "Hóa Thần - Đỉnh Phong",
  luyen_hu_so_ky: "Luyện Hư - Sơ Kỳ",
  luyen_hu_trung_ky: "Luyện Hư - Trung Kỳ",
  luyen_hu_hau_ky: "Luyện Hư - Hậu Kỳ",
  luyen_hu_dinh_phong: "Luyện Hư - Đỉnh Phong",
  tac_gia_canh: "Tác Giả Cảnh",
};

/**
 * Parses PNG width & height from IHDR chunk (bytes 16..24)
 */
function getPngDimensions(filePath: string): { width: number; height: number } {
  const fd = readFileSync(filePath);
  // PNG signature check
  if (
    fd[0] !== 0x89 ||
    fd[1] !== 0x50 ||
    fd[2] !== 0x4e ||
    fd[3] !== 0x47 ||
    fd[4] !== 0x0d ||
    fd[5] !== 0x0a ||
    fd[6] !== 0x1a ||
    fd[7] !== 0x0a
  ) {
    throw new Error(`File ${filePath} is not a valid PNG`);
  }
  const width = fd.readUInt32BE(16);
  const height = fd.readUInt32BE(20);
  return { width, height };
}

function toHumanName(slug: string): string {
  if (TITLE_LABELS[slug]) {
    return TITLE_LABELS[slug];
  }
  return slug
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const frontendRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(process.cwd(), "..", "kitlabs-film");

const titleEffectsDir = resolve(frontendRoot, "public/effects/title");

if (!existsSync(titleEffectsDir)) {
  console.error(`Title effects directory not found at: ${titleEffectsDir}`);
  process.exit(1);
}

const files = readdirSync(titleEffectsDir).filter(
  (f) => extname(f).toLowerCase() === ".png",
);

const titleItems: FilmTitleItemSeed[] = files
  .map((file) => {
    const slug = basename(file, extname(file));
    const fullPath = join(titleEffectsDir, file);
    const { width, height } = getPngDimensions(fullPath);
    return {
      slug,
      name: toHumanName(slug),
      width,
      height,
    };
  })
  .sort((a, b) => a.slug.localeCompare(b.slug));

const out = resolve(process.cwd(), "src/database/seeds/film-title-items.seed.ts");
mkdirSync(resolve(out, ".."), { recursive: true });

const content = `export interface FilmTitleItemSeed {
  slug: string;
  name: string;
  width: number;
  height: number;
}

export const FILM_TITLE_ITEM_SEED = ${JSON.stringify(titleItems, null, 2)} as const satisfies readonly FilmTitleItemSeed[];
`;

writeFileSync(out, content, "utf8");
console.log(`Generated ${out}: ${titleItems.length} title items from ${titleEffectsDir}`);
