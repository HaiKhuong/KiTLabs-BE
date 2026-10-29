import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { FilmActivityLog } from "../../entities/film.entities";

@Injectable()
export class FilmTrackingService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

  logActivity(
    userId: string,
    deviceId: string | null,
    data: Partial<FilmActivityLog> & { action: string },
    ip: string | null,
    userAgent: string | null,
  ) {
    const repo = this.db.getRepository(FilmActivityLog);
    return repo.save(repo.create({ ...data, userId, deviceId, ipAddress: ip, userAgent }));
  }
}

