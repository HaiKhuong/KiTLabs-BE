import { Column, Entity, ManyToOne, JoinColumn } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

@Entity("credit_histories")
export class CreditHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.creditHistories, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "numeric", precision: 12, scale: 2 })
  amount!: string;

  @Column({ type: "numeric", precision: 12, scale: 2 })
  balance!: string;

  @Column({ length: 255 })
  reason!: string;

  @Column({ type: "jsonb", nullable: true })
  metadata!: Record<string, unknown> | null;
}
