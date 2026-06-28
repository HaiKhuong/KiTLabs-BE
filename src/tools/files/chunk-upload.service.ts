import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { open } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { Repository } from "typeorm";

import { ChunkUpload, ChunkUploadStatus } from "./entities/chunk-upload.entity";
import { InitUploadDto } from "./dto/chunk-upload.dto";

const DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_FILE_SIZE = Number(process.env.CHUNK_UPLOAD_MAX_FILE_BYTES ?? 10 * 1024 * 1024 * 1024); // 10 GB
const MERGE_BUFFER_SIZE = 1024 * 1024; // 1 MB

@Injectable()
export class ChunkUploadService {
  private readonly logger = new Logger(ChunkUploadService.name);

  constructor(
    @InjectRepository(ChunkUpload, "tool")
    private readonly uploadRepo: Repository<ChunkUpload>,
  ) {}

  private getUploadBaseDir(): string {
    return process.env.CHUNK_UPLOAD_DIR ?? process.env.UPLOAD_DIR ?? "uploads";
  }

  private getChunkDir(uploadId: string): string {
    return join(this.getUploadBaseDir(), "_chunks", uploadId);
  }

  private resolveFinalDestination(folder?: string | null, userId?: string | null): string {
    const folderName = folder && folder.length > 0 ? folder : "videos";
    const safeUserId = userId ? userId.replace(/[^a-zA-Z0-9-_]/g, "") : "";
    const targetFolder = safeUserId ? join(folderName, safeUserId) : folderName;
    return join(this.getUploadBaseDir(), targetFolder);
  }

  async initUpload(dto: InitUploadDto): Promise<{ uploadId: string; totalChunks: number }> {
    if (dto.size > MAX_FILE_SIZE) {
      throw new BadRequestException(`File size exceeds maximum allowed (${MAX_FILE_SIZE} bytes)`);
    }

    const chunkSize = dto.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(dto.size / chunkSize);
    const uploadId = randomUUID().replace(/-/g, "").substring(0, 16);

    const chunkDir = this.getChunkDir(uploadId);
    mkdirSync(chunkDir, { recursive: true });

    writeFileSync(
      join(chunkDir, "metadata.json"),
      JSON.stringify({
        filename: dto.filename,
        size: dto.size,
        chunkSize,
        totalChunks,
      }),
    );

    const record = this.uploadRepo.create({
      uploadId,
      filename: dto.filename,
      size: dto.size,
      chunkSize,
      totalChunks,
      uploadedChunks: 0,
      status: ChunkUploadStatus.INIT,
      userId: dto.userId ?? null,
      folder: dto.folder ?? null,
    });
    await this.uploadRepo.save(record);

    this.logger.log(`Upload init: ${uploadId} — ${dto.filename} (${totalChunks} chunks)`);

    return { uploadId, totalChunks };
  }

  async uploadChunk(
    uploadId: string,
    chunkIndex: number,
    totalChunks: number,
    chunkHash: string | undefined,
    body: Readable,
  ): Promise<{ received: boolean; chunkIndex: number }> {
    const record = await this.uploadRepo.findOne({ where: { uploadId } });
    if (!record) {
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }
    if (record.status !== ChunkUploadStatus.INIT && record.status !== ChunkUploadStatus.UPLOADING) {
      throw new BadRequestException(`Upload ${uploadId} is not in a valid state (${record.status})`);
    }
    if (chunkIndex < 0 || chunkIndex >= record.totalChunks) {
      throw new BadRequestException(`Invalid chunk index ${chunkIndex} (total: ${record.totalChunks})`);
    }

    const chunkDir = this.getChunkDir(uploadId);
    if (!existsSync(chunkDir)) {
      throw new NotFoundException(`Chunk directory for ${uploadId} not found`);
    }

    const partPath = join(chunkDir, `${String(chunkIndex).padStart(6, "0")}.part`);

    const hashDigest = chunkHash ? createHash("sha256") : null;
    const writeStream = createWriteStream(partPath);

    if (hashDigest) {
      const { Transform } = await import("stream");
      const hashTransform = new Transform({
        transform(chunk, _encoding, callback) {
          hashDigest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(body, hashTransform, writeStream);
    } else {
      await pipeline(body, writeStream);
    }

    if (chunkHash && hashDigest) {
      const computed = hashDigest.digest("hex");
      if (computed !== chunkHash.toLowerCase()) {
        rmSync(partPath, { force: true });
        throw new BadRequestException(
          `Chunk ${chunkIndex} hash mismatch: expected ${chunkHash}, got ${computed}`,
        );
      }
    }

    const uploadedCount = this.countUploadedParts(chunkDir);
    await this.uploadRepo.update(
      { uploadId },
      { uploadedChunks: uploadedCount, status: ChunkUploadStatus.UPLOADING },
    );

    return { received: true, chunkIndex };
  }

  async getStatus(uploadId: string): Promise<{
    uploadId: string;
    filename: string;
    size: number;
    totalChunks: number;
    uploadedChunks: number;
    uploaded: number[];
    status: ChunkUploadStatus;
  }> {
    const record = await this.uploadRepo.findOne({ where: { uploadId } });
    if (!record) {
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }

    const chunkDir = this.getChunkDir(uploadId);
    const uploaded = existsSync(chunkDir) ? this.listUploadedIndices(chunkDir) : [];

    return {
      uploadId: record.uploadId,
      filename: record.filename,
      size: Number(record.size),
      totalChunks: record.totalChunks,
      uploadedChunks: uploaded.length,
      uploaded,
      status: record.status,
    };
  }

  async completeUpload(uploadId: string): Promise<{
    userId: string | null;
    originalName: string;
    fileName: string;
    filePath: string;
    size: number;
  }> {
    const record = await this.uploadRepo.findOne({ where: { uploadId } });
    if (!record) {
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }
    if (record.status === ChunkUploadStatus.DONE) {
      throw new BadRequestException(`Upload ${uploadId} is already completed`);
    }

    const chunkDir = this.getChunkDir(uploadId);
    const uploadedParts = this.countUploadedParts(chunkDir);
    if (uploadedParts < record.totalChunks) {
      throw new BadRequestException(
        `Not all chunks uploaded: ${uploadedParts}/${record.totalChunks}`,
      );
    }

    await this.uploadRepo.update({ uploadId }, { status: ChunkUploadStatus.MERGING });

    try {
      const finalDir = this.resolveFinalDestination(record.folder, record.userId);
      if (!existsSync(finalDir)) {
        mkdirSync(finalDir, { recursive: true });
      }

      const fileName = record.filename;

      const finalPath = join(finalDir, fileName);

      await this.mergeChunks(chunkDir, finalPath, record.totalChunks);

      rmSync(chunkDir, { recursive: true, force: true });

      await this.uploadRepo.update(
        { uploadId },
        {
          status: ChunkUploadStatus.DONE,
          finalPath: finalPath.replaceAll("\\", "/"),
          uploadedChunks: record.totalChunks,
        },
      );

      this.logger.log(`Upload complete: ${uploadId} → ${finalPath}`);

      return {
        userId: record.userId,
        originalName: record.filename,
        fileName,
        filePath: finalPath.replaceAll("\\", "/"),
        size: Number(record.size),
      };
    } catch (error) {
      await this.uploadRepo.update({ uploadId }, { status: ChunkUploadStatus.FAILED });
      this.logger.error(`Upload merge failed: ${uploadId}`, (error as Error).stack);
      throw error;
    }
  }

  async cancelUpload(uploadId: string): Promise<{ cancelled: boolean }> {
    const record = await this.uploadRepo.findOne({ where: { uploadId } });
    if (!record) {
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }

    const chunkDir = this.getChunkDir(uploadId);
    if (existsSync(chunkDir)) {
      rmSync(chunkDir, { recursive: true, force: true });
    }

    await this.uploadRepo.update({ uploadId }, { status: ChunkUploadStatus.CANCELLED });

    this.logger.log(`Upload cancelled: ${uploadId}`);
    return { cancelled: true };
  }

  private async mergeChunks(chunkDir: string, outputPath: string, totalChunks: number): Promise<void> {
    const outHandle = await open(outputPath, "w");
    const buffer = Buffer.alloc(MERGE_BUFFER_SIZE);

    try {
      for (let i = 0; i < totalChunks; i++) {
        const partPath = join(chunkDir, `${String(i).padStart(6, "0")}.part`);
        if (!existsSync(partPath)) {
          throw new BadRequestException(`Missing chunk ${i}`);
        }

        const inHandle = await open(partPath, "r");
        try {
          while (true) {
            const { bytesRead } = await inHandle.read(buffer, 0, MERGE_BUFFER_SIZE, null);
            if (bytesRead === 0) break;
            await outHandle.write(buffer, 0, bytesRead);
          }
        } finally {
          await inHandle.close();
        }
      }
    } finally {
      await outHandle.close();
    }
  }

  private countUploadedParts(chunkDir: string): number {
    if (!existsSync(chunkDir)) return 0;
    return readdirSync(chunkDir).filter((f) => f.endsWith(".part")).length;
  }

  private listUploadedIndices(chunkDir: string): number[] {
    return readdirSync(chunkDir)
      .filter((f) => f.endsWith(".part"))
      .map((f) => parseInt(f.replace(".part", ""), 10))
      .sort((a, b) => a - b);
  }
}
