import { Column, Entity } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

@Entity("ai_chat_histories")
export class AiChatHistory extends BaseEntity {
  @Column({ type: "varchar", length: 500, nullable: true })
  title!: string | null;

  @Column({ type: "jsonb", default: [] })
  messages!: ChatMessage[];

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ name: "is_archived", type: "boolean", default: false })
  isArchived!: boolean;
}
