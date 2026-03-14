import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { LogsService } from "../logs/logs.service";
import { User } from "../users/user.entity";
import { CreateDownloadDto } from "./dto/create-download.dto";
import { DownloadHistory } from "./download-history.entity";

@Injectable()
export class DownloadsService {
  constructor(
    @InjectRepository(DownloadHistory, "tool")
    private readonly downloadRepository: Repository<DownloadHistory>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    private readonly logsService: LogsService,
  ) {}

  async create(dto: CreateDownloadDto): Promise<DownloadHistory> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const history = this.downloadRepository.create({
      userId: user.id,
      sourceType: dto.sourceType,
      sourceValue: dto.sourceValue,
      savedPath: dto.savePath ?? null,
      status: "completed",
      message: "Download record created",
    });
    const saved = await this.downloadRepository.save(history);

    await this.logsService.createLog({
      userId: user.id,
      action: "download.created",
      payload: {
        sourceType: dto.sourceType,
        sourceValue: dto.sourceValue,
        savePath: dto.savePath ?? null,
      },
      ip: user.ip,
    });
    return saved;
  }

  async histories(userId: string): Promise<DownloadHistory[]> {
    return this.downloadRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }
}
