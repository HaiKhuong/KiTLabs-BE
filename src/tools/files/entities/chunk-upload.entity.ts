import { Column, Entity } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";

export enum ChunkUploadStatus {
  INIT = "init",
  UPLOADING = "uploading",
  MERGING = "merging",
  DONE = "done",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

@Entity("chunk_uploads")
export class ChunkUpload extends BaseEntity {
  @Column({ name: "upload_id", type: "varchar", length: 64, unique: true })
  uploadId!: string;

  @Column({ type: "text" })
  filename!: string;

  @Column({ type: "bigint" })
  size!: number;

  @Column({ name: "chunk_size", type: "int" })
  chunkSize!: number;

  @Column({ name: "total_chunks", type: "int" })
  totalChunks!: number;

  @Column({ name: "uploaded_chunks", type: "int", default: 0 })
  uploadedChunks!: number;

  @Column({ type: "enum", enum: ChunkUploadStatus, default: ChunkUploadStatus.INIT })
  status!: ChunkUploadStatus;

  @Column({ name: "user_id", type: "varchar", length: 100, nullable: true })
  userId!: string | null;

  @Column({ type: "varchar", length: 200, nullable: true })
  folder!: string | null;

  @Column({ name: "final_path", type: "text", nullable: true })
  finalPath!: string | null;
}
