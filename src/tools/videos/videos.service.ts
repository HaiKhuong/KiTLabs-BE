import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { Repository } from "typeorm";

import { UpsertVideoWorkflowDto } from "./dto/upsert-video-workflow.dto";
import { VideoWorkflow } from "./video-workflow.entity";

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(VideoWorkflow, "tool")
    private readonly workflowRepo: Repository<VideoWorkflow>,
  ) {}

  async getByUser(userId: string, name = "default"): Promise<VideoWorkflow | null> {
    return this.workflowRepo.findOne({ where: { userId, name } });
  }

  async upsert(dto: UpsertVideoWorkflowDto): Promise<VideoWorkflow> {
    const name = dto.name?.trim() || "default";
    const contentHash =
      dto.contentHash?.trim() ||
      createHash("sha256").update(JSON.stringify(dto.document)).digest("hex");

    let row = await this.workflowRepo.findOne({
      where: { userId: dto.userId, name },
    });

    if (!row) {
      row = this.workflowRepo.create({
        userId: dto.userId,
        name,
        document: dto.document,
        nodesExport: dto.nodesExport,
        contentHash,
      });
    } else {
      // Skip write if unchanged
      if (row.contentHash === contentHash) {
        return row;
      }
      row.document = dto.document;
      row.nodesExport = dto.nodesExport;
      row.contentHash = contentHash;
    }

    return this.workflowRepo.save(row);
  }
}
