import { Column, Entity, Unique } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";

@Entity("settings")
@Unique(["type", "code"])
export class Setting extends BaseEntity {
  @Column({ length: 100 })
  type!: string;

  @Column({ length: 100 })
  code!: string;

  @Column({ type: "text" })
  value!: string;
}
