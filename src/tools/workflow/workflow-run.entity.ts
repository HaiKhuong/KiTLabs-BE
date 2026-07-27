import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { WorkflowEntity } from "./workflow.entity";

export type WorkflowRunStatus = "completed" | "partial" | "failed";

export type WorkflowRunNodeSummary = {
  nodeId: string;
  label: string;
  nodeType: string;
  status: string;
};

@Entity("video_workflow_runs")
@Index("IDX_video_workflow_runs_user_workflow_created", ["userId", "workflowId", "createdAt"])
export class WorkflowRunEntity extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "workflow_id", type: "uuid" })
  workflowId!: string;

  @ManyToOne(() => WorkflowEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "workflow_id" })
  workflow!: WorkflowEntity;

  @Column({ name: "workflow_name", type: "varchar", length: 255 })
  workflowName!: string;

  @Column({ type: "varchar", length: 32 })
  status!: WorkflowRunStatus;

  @Column({ name: "started_at", type: "timestamp", nullable: true })
  startedAt!: Date | null;

  @Column({ name: "finished_at", type: "timestamp", nullable: true })
  finishedAt!: Date | null;

  @Column({ name: "duration_ms", type: "integer", nullable: true })
  durationMs!: number | null;

  @Column({ type: "jsonb" })
  snapshot!: Record<string, unknown>;

  @Column({ type: "jsonb" })
  summary!: WorkflowRunNodeSummary[];

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;
}
