import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { CreateWorkflowRunDto } from "./dto/create-workflow-run.dto";
import { WorkflowRunEntity, WorkflowRunNodeSummary } from "./workflow-run.entity";
import { WorkflowService } from "./workflow.service";

@Injectable()
export class WorkflowRunService {
  constructor(
    @InjectRepository(WorkflowRunEntity, "tool")
    private readonly runRepo: Repository<WorkflowRunEntity>,
    private readonly workflowService: WorkflowService,
  ) {}

  private mapListItem(row: WorkflowRunEntity) {
    const summary = Array.isArray(row.summary) ? row.summary : [];
    const doneCount = summary.filter((item) => item.status === "done").length;
    const errorCount = summary.filter((item) => item.status === "error").length;
    return {
      id: row.id,
      userId: row.userId,
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      summary,
      doneCount,
      errorCount,
      nodeCount: summary.length,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapDetail(row: WorkflowRunEntity) {
    return {
      ...this.mapListItem(row),
      snapshot: row.snapshot,
    };
  }

  async create(dto: CreateWorkflowRunDto) {
    const workflow = await this.workflowService.getById(dto.workflowId, dto.userId);
    const startedAt = dto.startedAt ? new Date(dto.startedAt) : new Date();
    const finishedAt = dto.finishedAt ? new Date(dto.finishedAt) : new Date();
    const durationMs =
      typeof dto.durationMs === "number" && Number.isFinite(dto.durationMs)
        ? Math.max(0, Math.round(dto.durationMs))
        : Math.max(0, finishedAt.getTime() - startedAt.getTime());

    const summary: WorkflowRunNodeSummary[] = Array.isArray(dto.summary)
      ? dto.summary.map((item) => ({
          nodeId: String(item.nodeId ?? ""),
          label: String(item.label ?? ""),
          nodeType: String(item.nodeType ?? ""),
          status: String(item.status ?? "idle"),
        }))
      : [];

    const row = this.runRepo.create({
      userId: dto.userId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: dto.status,
      startedAt,
      finishedAt,
      durationMs,
      snapshot: dto.snapshot,
      summary,
      errorMessage: dto.errorMessage?.trim() || null,
    });

    const saved = await this.runRepo.save(row);
    return this.mapDetail(saved);
  }

  async list(userId: string, workflowId: string, page = 1, limit = 20) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    if (!workflowId?.trim()) throw new BadRequestException("workflowId is required");

    // Ensure ownership
    await this.workflowService.getById(workflowId.trim(), userId.trim());

    const take = Math.min(Math.max(1, Math.trunc(limit) || 20), 50);
    const currentPage = Math.max(1, Math.trunc(page) || 1);
    const skip = (currentPage - 1) * take;

    const [rows, total] = await this.runRepo.findAndCount({
      where: { userId: userId.trim(), workflowId: workflowId.trim() },
      order: { createdAt: "DESC" },
      take,
      skip,
    });

    return {
      items: rows.map((row) => this.mapListItem(row)),
      total,
      page: currentPage,
      limit: take,
      hasMore: skip + rows.length < total,
    };
  }

  async getById(id: string, userId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const row = await this.runRepo.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Workflow run not found");
    return this.mapDetail(row);
  }

  async deleteOne(id: string, userId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const row = await this.runRepo.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Workflow run not found");
    await this.runRepo.delete({ id, userId: userId.trim() });
    return { deleted: true, id };
  }

  async deleteAll(userId: string, workflowId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    if (!workflowId?.trim()) throw new BadRequestException("workflowId is required");
    await this.workflowService.getById(workflowId.trim(), userId.trim());
    const result = await this.runRepo.delete({
      userId: userId.trim(),
      workflowId: workflowId.trim(),
    });
    return { deleted: result.affected ?? 0 };
  }
}
