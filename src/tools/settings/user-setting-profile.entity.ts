import { Column, Entity, JoinColumn, ManyToOne, OneToMany, Unique } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { UserSetting } from "./user-setting.entity";

@Entity("user_setting_profiles")
@Unique(["userId", "type", "name"])
export class UserSettingProfile extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.userSettingProfiles, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ length: 100 })
  type!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ name: "is_default", default: false })
  isDefault!: boolean;

  @Column({ name: "direct_url", nullable: true })
  directUrl?: string;

  @OneToMany(() => UserSetting, (setting) => setting.profile)
  userSettings!: UserSetting[];
}
