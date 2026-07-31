import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

export type WhiteboardIdeaStoryboardRow = {
  voice: string;
  visuals: string[];
};

export type WhiteboardIdeaSceneRow = {
  title: string;
  storyboards: WhiteboardIdeaStoryboardRow[];
};

@Entity("whiteboard_idea_histories")
@Index("IDX_whiteboard_idea_histories_user_id_created_at", ["userId", "createdAt"])
export class WhiteboardIdeaHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "title", type: "varchar", length: 255 })
  title!: string;

  @Column({ name: "idea", type: "text" })
  idea!: string;

  @Column({ name: "model", type: "varchar", length: 128 })
  model!: string;

  @Column({ name: "scenes", type: "jsonb" })
  scenes!: WhiteboardIdeaSceneRow[];
}
