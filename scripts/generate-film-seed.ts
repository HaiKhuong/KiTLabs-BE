import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

type LegacyMovie = {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  backdrop: string;
  episode: string;
  quality: string;
  views: string;
  rating: number;
  year: number;
  genres: string[];
  watchUrl?: string;
  topAllRank?: number;
  isHot?: boolean;
};
type LegacyComment = { name: string; copy: string; titleSlug: string };

const frontendRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(process.cwd(), "..", "kitlabs-film");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { movies } = require(resolve(frontendRoot, "src/mocks/movies.ts")) as { movies: LegacyMovie[] };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { comments } = require(resolve(frontendRoot, "src/mocks/comments.ts")) as { comments: LegacyComment[] };
const parseViews = (value: string) => {
  const n = Number.parseFloat(value.replace(",", "."));
  return Math.round(n * (/B/i.test(value) ? 1e9 : /M/i.test(value) ? 1e6 : /K/i.test(value) ? 1e3 : 1));
};
const seed = {
  movies: movies.map((movie) => ({
    slug: movie.slug,
    title: movie.title,
    originalTitle: movie.subtitle,
    description: movie.description,
    posterUrl: movie.image,
    bannerUrl: movie.backdrop,
    releaseYear: movie.year,
    currentEpisodeCount: Number(movie.episode.match(/\d+/)?.[0] || 0),
    views: parseViews(movie.views),
    ratingAvg: Math.min(5, Number((movie.rating / 2).toFixed(2))),
    isHot: !!movie.isHot,
    rankScore: movie.topAllRank ? (4 - movie.topAllRank) * 1_000_000 : 0,
    genres: movie.genres,
    quality: movie.quality,
    watchUrl: movie.watchUrl || null,
  })),
  comments: comments.map((comment) => ({ name: comment.name, content: comment.copy, titleSlug: comment.titleSlug })),
};
const out = resolve(process.cwd(), "src/database/seeds/film-default.seed.ts");
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(
  out,
  `// Generated from kitlabs-film mocks. Regenerate with: npm run seed:generate:film\nexport const FILM_DEFAULT_SEED = ${JSON.stringify(seed, null, 2)} as const;\n`,
);
console.log(`Generated ${out}: ${seed.movies.length} movies, ${seed.comments.length} comments`);
