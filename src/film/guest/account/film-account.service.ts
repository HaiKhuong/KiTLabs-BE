import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, IsNull } from "typeorm";
import {
  FilmComment,
  FilmCommentReaction,
  FilmDonation,
  FilmFavorite,
  FilmMovie,
  FilmNotification,
  FilmRating,
  FilmUser,
  FilmUserInventory,
  FilmWatchHistory,
  ReactionType,
} from "../../entities/film.entities";
import { filmRankFor } from "../../shared/film-rank.util";
import { CommentDto, RatingDto, WatchDto } from "./dto";

@Injectable()
export class FilmAccountService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

  async saveWatch(userId: string, input: WatchDto) {
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(FilmWatchHistory);
      let row = await repo
        .createQueryBuilder("w")
        .setLock("pessimistic_write")
        .where("w.userId = :userId AND w.episodeId = :episodeId", {
          userId,
          episodeId: input.episodeId,
        })
        .getOne();

      const before = row?.watchedMinutes || 0;
      const next = Math.max(before, input.watchedMinutes);

      if (!row) {
        row = repo.create({
          userId,
          movieId: input.movieId,
          episodeId: input.episodeId,
          stoppedAtSeconds: input.stoppedAtSeconds,
          watchedMinutes: next,
        });
      } else {
        Object.assign(row, { stoppedAtSeconds: input.stoppedAtSeconds, watchedMinutes: next });
      }

      const delta = next - before;
      if (delta > 0) {
        const user = await manager
          .getRepository(FilmUser)
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.id = :userId", { userId })
          .getOneOrFail();

        user.totalViewMinutes = String(BigInt(user.totalViewMinutes) + BigInt(delta));
        user.exp = String(BigInt(user.exp) + BigInt(delta * 10));
        user.sectRank = filmRankFor(Number(user.exp));

        await manager.save(user);
      }

      return repo.save(row);
    });
  }

  history(userId: string) {
    return this.db
      .getRepository(FilmWatchHistory)
      .find({ where: { userId }, order: { updatedAt: "DESC" } });
  }

  async favorite(userId: string, movieId: string) {
    const repo = this.db.getRepository(FilmFavorite);
    const old = await repo.findOne({ where: { userId, movieId }, withDeleted: true });

    if (old) {
      if (old.deletedAt) {
        await repo.restore(old.id);
        return { favorite: true };
      }
      await repo.softDelete(old.id);
      return { favorite: false };
    }

    await repo.save(repo.create({ userId, movieId }));
    return { favorite: true };
  }

  favorites(userId: string) {
    return this.db
      .getRepository(FilmFavorite)
      .find({ where: { userId }, order: { createdAt: "DESC" } });
  }

  async rate(userId: string, input: RatingDto) {
    if (input.score < 1 || input.score > 5) {
      throw new BadRequestException("score must be 1..5");
    }

    await this.db.getRepository(FilmRating).upsert({ userId, ...input }, ["userId", "movieId"]);

    const stats = await this.db
      .getRepository(FilmRating)
      .createQueryBuilder("r")
      .select("AVG(r.score)", "avg")
      .addSelect("COUNT(*)", "count")
      .where("r.movieId = :id", { id: input.movieId })
      .getRawOne<{ avg: string; count: string }>();

    await this.db.getRepository(FilmMovie).update(input.movieId, {
      ratingAvg: String(Number(stats?.avg || 0).toFixed(2)),
      ratingCount: Number(stats?.count || 0),
    });

    return this.db.getRepository(FilmRating).findOneBy({ userId, movieId: input.movieId });
  }

  async comment(userId: string, input: CommentDto) {
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    return this.db.getRepository(FilmComment).save(
      this.db.getRepository(FilmComment).create({
        ...input,
        userId,
        userSectRankSnapshot: user.sectRank,
      }),
    );
  }

  async react(userId: string, commentId: string, type: ReactionType) {
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(FilmCommentReaction);
      const old = await repo.findOneBy({ userId, commentId });

      if (old?.type === type) {
        await repo.delete({ userId, commentId });
      } else {
        await repo.save(repo.create({ userId, commentId, type }));
      }

      const counts = await repo
        .createQueryBuilder("r")
        .select("r.type", "type")
        .addSelect("COUNT(*)", "count")
        .where("r.commentId = :commentId", { commentId })
        .groupBy("r.type")
        .getRawMany<{ type: ReactionType; count: string }>();

      await manager.getRepository(FilmComment).update(commentId, {
        likesCount: Number(counts.find((x) => x.type === ReactionType.LIKE)?.count || 0),
        dislikesCount: Number(counts.find((x) => x.type === ReactionType.DISLIKE)?.count || 0),
      });

      return { type: old?.type === type ? null : type };
    });
  }

  inventory(userId: string) {
    return this.db.getRepository(FilmUserInventory).find({ where: { userId } });
  }

  notifications(userId: string) {
    return this.db
      .getRepository(FilmNotification)
      .find({ where: [{ userId }, { userId: IsNull() }], order: { createdAt: "DESC" } });
  }

  donations(userId: string) {
    return this.db
      .getRepository(FilmDonation)
      .find({ where: { userId }, order: { createdAt: "DESC" } });
  }
}

