import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ChunkUpload } from "./entities/chunk-upload.entity";
import { ChunkUploadService } from "./chunk-upload.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

@Module({
  imports: [TypeOrmModule.forFeature([ChunkUpload], "tool")],
  controllers: [FilesController],
  providers: [FilesService, ChunkUploadService],
  exports: [FilesService, ChunkUploadService],
})
export class FilesModule {}
