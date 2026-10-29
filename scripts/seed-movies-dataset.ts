import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
import { FILM_GENRES_SEED } from "../src/database/seeds/film-genres.seed";

interface DatasetEpisode {
  title: string;
  youtube_id: string;
  youtube_url: string;
  duration_seconds: number;
  views: number;
  publish_date: string;
}

interface DatasetMovie {
  id: number;
  movie_title: string;
  total_episodes: number;
  total_views: number;
  total_duration_seconds: number;
  episodes: DatasetEpisode[];
}

function determineMovieStatus(episodes: DatasetEpisode[]): "COMPLETED" | "ONGOING" {
  if (!episodes || episodes.length === 0) return "ONGOING";
  const hasFullEnd = episodes.some((ep) =>
    /full\s*end|full\s*\d+|hoàn\s*thành/i.test(ep.title || "")
  );
  if (hasFullEnd) return "COMPLETED";
  return "ONGOING";
}

function matchGenreSlugs(title: string): string[] {
  const lower = title.toLowerCase();
  const matched = new Set<string>();

  if (/trọng sinh/i.test(lower)) matched.add("trong-sinh");
  if (/xuyên không|dị bản|giếng cổ|tủ lạnh/i.test(lower)) matched.add("xuyen-khong");
  if (/hệ thống|thần tài|đan thần/i.test(lower)) matched.add("he-thong");
  if (/vô địch|thần cấp|ông chủ|nghiền ép/i.test(lower)) matched.add("vo-dich-luu");
  if (/giấu nghề|bảo an|tắm trần|tổ sư|nằm ngửa/i.test(lower)) matched.add("giau-nghe");
  if (/phản diện|ác nhân/i.test(lower)) matched.add("phan-dien-luu");
  if (/dị thú|côn trùng|lửng mật|rồng/i.test(lower)) matched.add("di-thu-tien-hoa");
  if (/phế vật|phế sài|huyết nô|khô lâu/i.test(lower)) matched.add("phe-vat-nghich-thien");
  if (/mạt thế|tận thế|cầu sinh|quân đoàn/i.test(lower)) matched.add("mat-the");
  if (/trò chơi|phó bản|sololeveling|hải tặc/i.test(lower)) matched.add("tro-choi-hoa");
  if (/ma đạo|tà tu|ma tôn|ma thần/i.test(lower)) matched.add("ma-dao-ta-tu");
  if (/nữ cường|sư tỷ|cô gái/i.test(lower)) matched.add("nu-cuong");
  if (/tây du|đường tăng|ngộ không|wukong/i.test(lower)) matched.add("tay-du");
  if (/hài|mèo béo|lửng mật/i.test(lower)) matched.add("hai-huoc");
  if (/sát phạt|quốc vận|chém sát|chiến/i.test(lower)) matched.add("sat-phat");
  if (/hậu cung|tiên tử/i.test(lower)) matched.add("hau-cung");

  if (matched.size === 0) {
    matched.add("vo-dich-luu");
  }

  return Array.from(matched);
}

function slugify(text: string): string {
  return text
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/([^0-9a-z-\s])/g, "")
    .replace(/(\s+)/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseReleaseYear(publishDate?: string): number {
  if (!publishDate) return 2026;
  const match = publishDate.match(/\b(20\d{2})\b/);
  return match ? parseInt(match[1], 10) : 2026;
}

async function seed() {
  const jsonPath = resolve(__dirname, "../movies_grouped_dataset.json");
  if (!existsSync(jsonPath)) {
    console.error(`Dataset not found at ${jsonPath}`);
    process.exit(1);
  }

  const raw = readFileSync(jsonPath, "utf-8");
  const dataset: DatasetMovie[] = JSON.parse(raw);

  console.log(`Loaded dataset with ${dataset.length} movies.`);

  const host = process.env.FILM_DB_HOST || "localhost";
  const port = Number(process.env.FILM_DB_PORT || 5432);
  const user = process.env.FILM_DB_USER || "postgres";
  const password = process.env.FILM_DB_PASSWORD || "1231";
  const database = process.env.FILM_DB_NAME || "kitlabs_film";

  const client = new Client({ host, port, user, password, database });
  await client.connect();

  console.log(`Connected to PostgreSQL database: ${database} at ${host}:${port}`);

  try {
    await client.query("BEGIN");

    // 1. Seed Genres
    console.log("--> Seeding default genres...");
    const genreMap = new Map<string, string>(); // slug -> id
    for (const g of FILM_GENRES_SEED) {
      const res = await client.query(
        `INSERT INTO genres (name, slug, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description
         RETURNING id, slug`,
        [g.name, g.slug, g.description]
      );
      genreMap.set(res.rows[0].slug, res.rows[0].id);
    }
    console.log(`Seeded ${genreMap.size} genres.`);

    // 2. Sort movies by views to determine Hot & Recommended
    const sortedByViews = [...dataset].sort((a, b) => (b.total_views || 0) - (a.total_views || 0));
    const topHotIds = new Set(sortedByViews.slice(0, 10).map((m) => m.id));
    const topRecommendedIds = new Set(sortedByViews.slice(0, 20).map((m) => m.id));

    let moviesCount = 0;
    let episodesCount = 0;
    let sourcesCount = 0;

    for (const item of dataset) {
      const slug = slugify(item.movie_title) || `movie-${item.id}`;
      const firstEp = item.episodes && item.episodes[0];
      const bannerUrl = firstEp?.youtube_id
        ? `https://img.youtube.com/vi/${firstEp.youtube_id}/hqdefault.jpg`
        : null;

      const status = determineMovieStatus(item.episodes || []);
      const releaseYear = firstEp ? parseReleaseYear(firstEp.publish_date) : 2026;
      const currentEpisodeCount = item.episodes ? item.episodes.length : 1;
      const views = item.total_views || 0;
      const rankScore = views;
      const ratingAvg = (4.6 + ((views % 35) / 100)).toFixed(2);
      const ratingCount = Math.max(15, Math.floor(views / 800));
      const isHot = topHotIds.has(item.id);
      const isRecommended = topRecommendedIds.has(item.id);

      // Insert or Update Movie
      const movieRes = await client.query(
        `INSERT INTO movies (
          title, slug, banner_url, status, release_year,
          current_episode_count, views, rating_avg, rating_count,
          rank_score, is_hot, is_recommended
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (slug) DO UPDATE
          SET title = EXCLUDED.title,
              banner_url = EXCLUDED.banner_url,
              status = EXCLUDED.status,
              release_year = EXCLUDED.release_year,
              current_episode_count = EXCLUDED.current_episode_count,
              views = EXCLUDED.views,
              rating_avg = EXCLUDED.rating_avg,
              rating_count = EXCLUDED.rating_count,
              rank_score = EXCLUDED.rank_score,
              is_hot = EXCLUDED.is_hot,
              is_recommended = EXCLUDED.is_recommended,
              updated_at = now()
        RETURNING id`,
        [
          item.movie_title,
          slug,
          bannerUrl,
          status,
          releaseYear,
          currentEpisodeCount,
          views,
          ratingAvg,
          ratingCount,
          rankScore,
          isHot,
          isRecommended,
        ]
      );

      const movieId = movieRes.rows[0].id;
      moviesCount++;

      // Link Movie Genres
      const matchedSlugs = matchGenreSlugs(item.movie_title);
      for (const genreSlug of matchedSlugs) {
        const genreId = genreMap.get(genreSlug);
        if (genreId) {
          await client.query(
            `INSERT INTO movie_genres (movie_id, genre_id)
             VALUES ($1, $2)
             ON CONFLICT (movie_id, genre_id) DO NOTHING`,
            [movieId, genreId]
          );
        }
      }

      // 3. Seed Episodes and Episode Sources
      if (item.episodes && item.episodes.length > 0) {
        for (let idx = 0; idx < item.episodes.length; idx++) {
          const ep = item.episodes[idx];
          const epNumber = idx + 1;
          const epThumbnail = ep.youtube_id
            ? `https://img.youtube.com/vi/${ep.youtube_id}/hqdefault.jpg`
            : null;

          const epRes = await client.query(
            `INSERT INTO episodes (
              movie_id, episode_number, title, duration_seconds, views, thumbnail_url
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (movie_id, episode_number) DO UPDATE
              SET title = EXCLUDED.title,
                  duration_seconds = EXCLUDED.duration_seconds,
                  views = EXCLUDED.views,
                  thumbnail_url = EXCLUDED.thumbnail_url,
                  updated_at = now()
            RETURNING id`,
            [
              movieId,
              epNumber,
              ep.title || `Tập ${epNumber}`,
              ep.duration_seconds || 0,
              ep.views || 0,
              epThumbnail,
            ]
          );

          const episodeId = epRes.rows[0].id;
          episodesCount++;

          // Episode Source (YouTube VIP Embed)
          const videoUrl = ep.youtube_url || `https://www.youtube.com/watch?v=${ep.youtube_id}`;
          const existingSourceRes = await client.query(
            `SELECT id FROM episode_sources WHERE episode_id = $1 AND server_name = $2`,
            [episodeId, "YouTube VIP"]
          );

          if (existingSourceRes.rows.length > 0) {
            const sourceId = existingSourceRes.rows[0].id;
            await client.query(
              `UPDATE episode_sources
               SET video_url = $2, source_type = 'EMBED', quality = '1080P', is_active = true, updated_at = now()
               WHERE id = $1`,
              [sourceId, videoUrl]
            );
            // Clean up any extraneous duplicates for this episode if any
            if (existingSourceRes.rows.length > 1) {
              const extraIds = existingSourceRes.rows.slice(1).map((r: any) => r.id);
              await client.query(`DELETE FROM episode_sources WHERE id = ANY($1::uuid[])`, [extraIds]);
            }
          } else {
            await client.query(
              `INSERT INTO episode_sources (
                episode_id, server_name, source_type, quality, video_url, is_active, priority
              )
              VALUES ($1, 'YouTube VIP', 'EMBED', '1080P', $2, true, 1)`,
              [episodeId, videoUrl]
            );
          }

          sourcesCount++;
        }
      }
    }

    await client.query("COMMIT");
    console.log("=========================================");
    console.log(`✅ SEED COMPLETED SUCCESSFULLY!`);
    console.log(`🎬 Total Movies Seeded:   ${moviesCount}`);
    console.log(`📺 Total Episodes Seeded: ${episodesCount}`);
    console.log(`🔗 Total Sources Seeded:  ${sourcesCount}`);
    console.log("=========================================");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error while seeding movies:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error("Fatal seed error:", err);
  process.exit(1);
});
