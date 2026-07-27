import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import { Repository } from "typeorm";

import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { RenameWorkflowDto } from "./dto/rename-workflow.dto";
import { UpsertWorkflowDto } from "./dto/upsert-workflow.dto";
import { WorkflowEntity } from "./workflow.entity";

export type WorkflowProfileSummary = {
  id: string;
  name: string;
  displayName: string;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class WorkflowService {
  constructor(
    @InjectRepository(WorkflowEntity, "tool")
    private readonly workflowRepo: Repository<WorkflowEntity>,
  ) {}

  /** Normalize profile key: lowercase, spaces → `-`, strip invalid chars. */
  static normalizeName(raw: string): string {
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "default";
  }

  private displayNameFromDocument(document: Record<string, unknown> | null | undefined, fallback: string): string {
    const name = typeof document?.name === "string" ? document.name.trim() : "";
    return name || fallback;
  }

  private toSummary(row: WorkflowEntity): WorkflowProfileSummary {
    return {
      id: row.id,
      name: row.name,
      displayName: this.displayNameFromDocument(row.document, row.name),
      contentHash: row.contentHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listByUser(userId: string): Promise<WorkflowProfileSummary[]> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const rows = await this.workflowRepo.find({
      where: { userId: userId.trim() },
      order: { updatedAt: "DESC" },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async getByUser(userId: string, name = "default"): Promise<WorkflowEntity | null> {
    return this.workflowRepo.findOne({
      where: { userId, name: WorkflowService.normalizeName(name) },
    });
  }

  async getById(id: string, userId: string): Promise<WorkflowEntity> {
    const row = await this.workflowRepo.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException("Workflow not found");
    return row;
  }

  async create(dto: CreateWorkflowDto): Promise<WorkflowEntity> {
    const name = WorkflowService.normalizeName(dto.name);
    const existing = await this.workflowRepo.findOne({
      where: { userId: dto.userId, name },
    });
    if (existing) {
      throw new ConflictException(`Workflow profile "${name}" already exists`);
    }

    const contentHash =
      dto.contentHash?.trim() ||
      createHash("sha256").update(JSON.stringify(dto.document)).digest("hex");

    const document = { ...dto.document };
    if (typeof document.name !== "string" || !String(document.name).trim()) {
      document.name = name;
    }

    const row = this.workflowRepo.create({
      userId: dto.userId,
      name,
      document,
      nodesExport: dto.nodesExport,
      contentHash,
    });
    return this.workflowRepo.save(row);
  }

  async upsert(dto: UpsertWorkflowDto): Promise<WorkflowEntity> {
    const name = WorkflowService.normalizeName(dto.name?.trim() || "default");
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
      if (row.contentHash === contentHash) {
        return row;
      }
      row.document = dto.document;
      row.nodesExport = dto.nodesExport;
      row.contentHash = contentHash;
    }

    return this.workflowRepo.save(row);
  }

  async rename(id: string, dto: RenameWorkflowDto): Promise<WorkflowEntity> {
    const row = await this.getById(id, dto.userId);
    const nextName = WorkflowService.normalizeName(dto.name);
    if (nextName !== row.name) {
      const clash = await this.workflowRepo.findOne({
        where: { userId: dto.userId, name: nextName },
      });
      if (clash) {
        throw new ConflictException(`Workflow profile "${nextName}" already exists`);
      }
      row.name = nextName;
    }

    const displayName = dto.displayName?.trim() || nextName;
    row.document = {
      ...(row.document ?? {}),
      name: displayName,
    };
    row.contentHash = createHash("sha256").update(JSON.stringify(row.document)).digest("hex");

    return this.workflowRepo.save(row);
  }

  async remove(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.getById(id, userId);
    await this.workflowRepo.delete({ id: row.id, userId });
    return { deleted: true, id: row.id };
  }
}
