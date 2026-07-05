import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import { existsSync, mkdirSync } from "fs";
import { diskStorage, memoryStorage } from "multer";
import { basename, extname, join, resolve } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { AUDIO_CLONE_UPLOAD_DIR, AUDIO_SOURCE_STUDIO, resolveAudioSourceType } from "./audio.constants";
import { AudioService } from "./audio.service";
import { CreateAudioJobDto } from "./dto/create-audio-job.dto";

const CLONE_ALLOWED_EXT = new Set([".mp3", ".wav", ".m4a"]);

type UploadRequest = {
  query: Record<string, unknown>;
  uploadDestination?: string;
};

const sanitizeUserId = (raw: unknown): string =>
  typeof raw === "string" ? raw.replace(/[^a-zA-Z0-9-_]/g, "") : "";

const resolveCloneDestination = (req: UploadRequest): string => {
  const userId = sanitizeUserId(req.query.userId);
  if (!userId) {
    throw new BadRequestException("userId query is required for clone upload");
  }
  return resolve(AUDIO_CLONE_UPLOAD_DIR, userId);
};

@ApiTags("Audio")
@ApiBearerAuth("bearer")
@Controller("tools/audio")
export class AudioController {
  constructor(private readonly audioService: AudioService) {}

  @ApiOperation({ summary: "List OmniVoice preset voices" })
  @Public()
  @Get("voices")
  listVoices() {
    return this.audioService.listPresetVoices();
  }

  @ApiOperation({ summary: "Get preset voice metadata" })
  @Public()
  @Get("voices/:voiceId")
  getVoice(@Param("voiceId") voiceId: string) {
    const voice = this.audioService.getPresetVoice(voiceId);
    return {
      id: voice.id,
      name: voice.name,
      tags: voice.tags,
      language: voice.language,
      gender: voice.gender,
      avatar: voice.avatar,
      previewUrl: `/api/tools/audio/voices/${voice.id}/preview`,
    };
  }

  @ApiOperation({ summary: "Stream ~3s OmniVoice preview for a preset voice" })
  @Public()
  @Get("voices/:voiceId/preview")
  async previewVoice(@Param("voiceId") voiceId: string, @Res() res: Response) {
    const { filePath, contentType } = await this.audioService.ensureVoicePreview(voiceId);
    res.setHeader("Content-Type", contentType);
    return res.sendFile(filePath);
  }

  @ApiOperation({ summary: "Upload clone reference audio (.mp3, .wav, .m4a)" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "refText", required: false, description: "Transcript of the clip" })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("clone/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadRequest = req as UploadRequest;
          try {
            const destination = resolveCloneDestination(uploadRequest);
            if (!existsSync(destination)) {
              mkdirSync(destination, { recursive: true });
            }
            uploadRequest.uploadDestination = destination;
            cb(null, destination);
          } catch (err) {
            cb(err as Error, "");
          }
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname).toLowerCase();
          const safeBase = basename(file.originalname, extname(file.originalname))
            .replace(/[\\/:*?"<>|]/g, "_")
            .trim();
          const base = safeBase || `clone_${Date.now()}`;
          cb(null, `${base}${CLONE_ALLOWED_EXT.has(ext) ? ext : ".wav"}`);
        },
      }),
      limits: { fileSize: Number(process.env.AUDIO_CLONE_MAX_BYTES ?? 25_000_000) },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!CLONE_ALLOWED_EXT.has(ext)) {
          cb(new BadRequestException("Only .mp3, .wav, .m4a are allowed."), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadClone(
    @UploadedFile() file: Express.Multer.File,
    @Query("userId") userId?: string,
    @Query("refText") refText?: string,
  ) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    if (!file) {
      throw new BadRequestException("file is required");
    }

    return {
      userId,
      originalName: file.originalname,
      fileName: file.filename,
      cloneRefWav: file.filename,
      filePath: file.path.replaceAll("\\", "/"),
      mimeType: file.mimetype,
      size: file.size,
      refText: refText?.trim() ?? null,
    };
  }

  @ApiOperation({ summary: "List voice samples under tools/video-pipeline/voice (translate Step3)" })
  @Public()
  @Get("pipeline-voices")
  async listPipelineVoices() {
    return this.audioService.listPipelineVoices();
  }

  @ApiOperation({ summary: "Upload voice sample + ref text (file on disk + row in DB)" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "refText", required: true, description: "Transcript of the reference clip" })
  @ApiQuery({
    name: "omnivoiceLanguage",
    required: true,
    description: "OmniVoice language: vietnamese | english | korean | japanese",
  })
  @ApiQuery({ name: "voiceName", required: false, description: "Optional display name / filename stem" })
  @ApiQuery({ name: "userId", required: false, description: "Owner user id (optional)" })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("pipeline-voices/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.AUDIO_CLONE_MAX_BYTES ?? 25_000_000) },
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!CLONE_ALLOWED_EXT.has(ext)) {
          cb(new BadRequestException("Only .mp3, .wav, .m4a are allowed."), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadPipelineVoice(
    @UploadedFile() file: Express.Multer.File,
    @Query("refText") refText?: string,
    @Query("omnivoiceLanguage") omnivoiceLanguage?: string,
    @Query("voiceName") voiceName?: string,
    @Query("userId") userId?: string,
  ) {
    if (!file) {
      throw new BadRequestException("file is required");
    }
    if (!omnivoiceLanguage?.trim()) {
      throw new BadRequestException("omnivoiceLanguage is required");
    }
    return this.audioService.savePipelineVoiceUpload({
      originalName: file.originalname,
      voiceName,
      refText: refText ?? "",
      omnivoiceLanguage: omnivoiceLanguage.trim(),
      buffer: file.buffer,
      userId,
    });
  }

  @ApiOperation({ summary: "Verify pipeline voice file exists under tools/video-pipeline/voice" })
  @Public()
  @Get("pipeline-voices/:fileName/verify")
  async verifyPipelineVoice(@Param("fileName") fileName: string) {
    return this.audioService.assertPipelineVoiceReady(fileName);
  }

  @ApiOperation({ summary: "Stream reference audio file for a pipeline voice" })
  @Public()
  @Get("pipeline-voices/:fileName/stream")
  async streamPipelineVoice(@Param("fileName") fileName: string, @Res() res: Response) {
    const info = await this.audioService.assertPipelineVoiceReady(fileName);
    const ext = extname(fileName).toLowerCase();
    let contentType = "audio/wav";
    if (ext === ".mp3") contentType = "audio/mpeg";
    if (ext === ".m4a") contentType = "audio/mp4";
    res.setHeader("Content-Type", contentType);
    return res.sendFile(info.absolutePath);
  }

  @ApiOperation({ summary: "Enqueue OmniVoice TTS job" })
  @Public()
  @Post("generate")
  generate(@Body() dto: CreateAudioJobDto) {
    return this.audioService.enqueue(dto);
  }

  @ApiOperation({ summary: "List user audio generation jobs (paginated)" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "sourceType", required: false, description: "auto | studio (mặc định studio cho trang Audio)" })
  @Public()
  @Get("jobs")
  async listJobs(
    @Query("userId") userId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("sourceType") sourceType?: string,
  ) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    const resolvedSource = resolveAudioSourceType(sourceType) ?? AUDIO_SOURCE_STUDIO;
    const result = await this.audioService.getHistory(userId, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      sourceType: resolvedSource,
    });
    return {
      items: result.items.map((row) => this.audioService.mapHistoryForClient(row)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
    };
  }

  @ApiOperation({ summary: "Delete all audio generation jobs for a user" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "sourceType", required: false, description: "auto | studio (mặc định: studio)" })
  @Public()
  @Delete("jobs")
  async deleteAllJobs(@Query("userId") userId?: string, @Query("sourceType") sourceType?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    const resolvedSource = resolveAudioSourceType(sourceType) ?? AUDIO_SOURCE_STUDIO;
    return this.audioService.deleteAllHistory(userId, resolvedSource);
  }

  @ApiOperation({ summary: "Get audio job by id" })
  @Public()
  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    const row = await this.audioService.getById(id);
    if (!row) {
      throw new BadRequestException("Job not found");
    }
    return this.audioService.mapHistoryForClient(row);
  }

  @ApiOperation({ summary: "Stream completed audio for in-browser playback" })
  @Public()
  @Get("jobs/:id/stream")
  async stream(@Param("id") id: string, @Res() res: Response) {
    const row = await this.audioService.getById(id);
    if (!row) {
      throw new BadRequestException("Job not found");
    }
    const abs = this.audioService.resolveResultPath(row);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `inline; filename="${basename(abs)}"`);
    res.setHeader("Accept-Ranges", "bytes");
    return res.sendFile(abs);
  }

  @ApiOperation({ summary: "Delete an audio generation job" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("jobs/:id")
  async deleteJob(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    await this.audioService.deleteHistory(userId, id);
    return { deleted: true, id };
  }

  @ApiOperation({ summary: "Download completed audio WAV" })
  @Public()
  @Get("jobs/:id/download")
  async download(@Param("id") id: string, @Res() res: Response) {
    const row = await this.audioService.getById(id);
    if (!row) {
      throw new BadRequestException("Job not found");
    }
    const abs = this.audioService.resolveResultPath(row);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `attachment; filename="${basename(abs)}"`);
    return res.sendFile(abs);
  }
}
