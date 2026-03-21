import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { LogsModule } from "../logs/logs.module";
import { User } from "../users/user.entity";
import { DownloadHistory } from "./download-history.entity";
import { DownloadsController } from "./downloads.controller";
import { DownloadsService } from "./downloads.service";
import { VideoDownload } from "./video-download.entity";

@Module({
  imports: [TypeOrmModule.forFeature([DownloadHistory, VideoDownload, User], "tool"), LogsModule],
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
