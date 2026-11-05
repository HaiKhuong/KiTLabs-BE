import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, ILike } from "typeorm";
import { FilmEpisode, FilmEpisodeSource, FilmMovie, SourceType, VideoQuality } from "../entities/film.entities";
import { SyncFacebookFilmDto } from "./film-facebook-integration.dto";

@Injectable()
export class FilmFacebookIntegrationService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

  async searchMovies(query: string) {
    const q = query.trim();
    const rows = await this.db.getRepository(FilmMovie).find({
      where: q ? { title: ILike(`%${q}%`) } : undefined,
      order: { updatedAt: "DESC" },
      take: 30,
    });
    return {
      items: rows.map((movie) => ({
        id: movie.id,
        title: movie.title,
        originalTitle: null,
        releaseYear: movie.releaseYear,
      })),
    };
  }

  async syncFacebookPost(dto: SyncFacebookFilmDto) {
    return this.db.transaction(async (manager) => {
      const movie = await manager.getRepository(FilmMovie).findOne({
        where: { id: dto.movieId },
        lock: { mode: "pessimistic_write" },
      });
      if (!movie) throw new NotFoundException("Không tìm thấy phim");

      const sources = manager.getRepository(FilmEpisodeSource);
      const existing = await sources.findOne({
        where: { externalProvider: "facebook", externalReference: dto.facebookPostUuid },
      });
      if (existing) {
        return {
          episodeId: existing.episodeId,
          sourceId: existing.id,
          videoUrl: existing.videoUrl,
          createdEpisode: false,
          createdSource: false,
        };
      }

      const episodes = manager.getRepository(FilmEpisode);
      const normalizedEpisode = dto.episodeNumber.toFixed(1);
      let episode = await episodes.findOne({
        where: { movieId: dto.movieId, episodeNumber: normalizedEpisode },
      });
      let createdEpisode = false;
      if (!episode) {
        episode = await episodes.save(episodes.create({
          movieId: dto.movieId,
          episodeNumber: normalizedEpisode,
          title: dto.title.trim() || `Tập ${dto.episodeNumber}`,
          durationSeconds: 0,
          views: "0",
          thumbnailUrl: null,
        }));
        createdEpisode = true;
      }

      await sources.update({ episodeId: episode.id, isActive: true }, { isActive: false });
      const source = await sources.save(sources.create({
        episodeId: episode.id,
        serverName: "Facebook",
        sourceType: SourceType.EMBED,
        quality: VideoQuality.AUTO,
        videoUrl: dto.permalink,
        isActive: true,
        priority: 1,
        externalProvider: "facebook",
        externalReference: dto.facebookPostUuid,
      }));

      return {
        episodeId: episode.id,
        sourceId: source.id,
        videoUrl: source.videoUrl,
        createdEpisode,
        createdSource: true,
      };
    });
  }
}
