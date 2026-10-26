import { MigrationInterface, QueryRunner } from "typeorm";
import { FILM_DEFAULT_SEED } from "../../seeds/film-default.seed";

export class FilmDefaultSeed1900000000001 implements MigrationInterface {
  name = "FilmDefaultSeed1900000000001";
  async up(q: QueryRunner): Promise<void> {
    const genres = new Map<string, string>();
    for (const name of [...new Set(FILM_DEFAULT_SEED.movies.flatMap((movie) => movie.genres))]) {
      const slug = name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/đ/g, "d")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const rows = await q.query(
        `INSERT INTO genres(name,slug) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [name, slug],
      );
      genres.set(name, rows[0].id);
    }
    let featuredMovieId: string | null = null;
    for (const [index, movie] of FILM_DEFAULT_SEED.movies.entries()) {
      const rows = await q.query(
        `INSERT INTO movies(title,original_title,slug,description,poster_url,banner_url,status,schedule,release_year,total_episodes,current_episode_count,views,rating_avg,rating_count,rank_score,is_hot,is_recommended) VALUES($1,$2,$3,$4,$5,$6,'ONGOING','UNKNOWN',$7,$8,$8,$9,$10,1,$11,$12,$13) ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,original_title=EXCLUDED.original_title,description=EXCLUDED.description,poster_url=EXCLUDED.poster_url,banner_url=EXCLUDED.banner_url,release_year=EXCLUDED.release_year,total_episodes=EXCLUDED.total_episodes,current_episode_count=EXCLUDED.current_episode_count,views=EXCLUDED.views,rating_avg=EXCLUDED.rating_avg,rank_score=EXCLUDED.rank_score,is_hot=EXCLUDED.is_hot,is_recommended=EXCLUDED.is_recommended RETURNING id`,
        [
          movie.title,
          movie.originalTitle,
          movie.slug,
          movie.description,
          movie.posterUrl,
          movie.bannerUrl,
          movie.releaseYear,
          movie.currentEpisodeCount,
          movie.views,
          movie.ratingAvg,
          movie.rankScore,
          movie.isHot,
          index === 3,
        ],
      );
      const movieId = rows[0].id as string;
      if (index === 3) featuredMovieId = movieId;
      for (const genre of movie.genres)
        await q.query(`INSERT INTO movie_genres(movie_id,genre_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [
          movieId,
          genres.get(genre),
        ]);
      if (movie.currentEpisodeCount > 0) {
        const episodes = await q.query(
          `INSERT INTO episodes(movie_id,episode_number,title,duration_seconds) VALUES($1,$2,$3,0) ON CONFLICT(movie_id,episode_number) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
          [movieId, movie.currentEpisodeCount, `Tập ${movie.currentEpisodeCount}`],
        );
        if (movie.watchUrl)
          await q.query(
            `INSERT INTO episode_sources(episode_id,server_name,source_type,quality,video_url,is_active,priority) SELECT $1,'YouTube','EMBED','AUTO',$2,true,1 WHERE NOT EXISTS(SELECT 1 FROM episode_sources WHERE episode_id=$1 AND video_url=$2)`,
            [episodes[0].id, movie.watchUrl],
          );
      }
    }
    if (featuredMovieId)
      for (const [index, comment] of FILM_DEFAULT_SEED.comments.entries()) {
        const users = await q.query(
          `INSERT INTO users(name,role,status,sect_rank,exp) VALUES($1,'GUEST','ACTIVE','LUYEN_KHI',0) RETURNING id`,
          [comment.name],
        );
        await q.query(
          `INSERT INTO comments(user_id,movie_id,content,user_sect_rank_snapshot,status,created_at) VALUES($1,$2,$3,'LUYEN_KHI','APPROVED',now()-($4::text||' minutes')::interval)`,
          [users[0].id, featuredMovieId, comment.content, index + 2],
        );
      }
  }
  async down(q: QueryRunner): Promise<void> {
    const slugs = FILM_DEFAULT_SEED.movies.map((movie) => movie.slug);
    const users = await q.query(
      `SELECT DISTINCT user_id FROM comments WHERE movie_id IN (SELECT id FROM movies WHERE slug=ANY($1))`,
      [slugs],
    );
    await q.query(`DELETE FROM comments WHERE movie_id IN (SELECT id FROM movies WHERE slug=ANY($1))`, [slugs]);
    if (users.length)
      await q.query(`DELETE FROM users WHERE id=ANY($1)`, [users.map((row: { user_id: string }) => row.user_id)]);
    await q.query(`DELETE FROM movies WHERE slug=ANY($1)`, [slugs]);
  }
}
