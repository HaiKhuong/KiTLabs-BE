import { Column, Entity, JoinColumn, ManyToOne, Unique } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { UserSettingProfile } from "./user-setting-profile.entity";

@Entity("user_settings")
@Unique(["profileId", "type", "code"])
export class UserSetting extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.userSettings, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "profile_id" })
  profileId!: string;

  @ManyToOne(() => UserSettingProfile, (profile) => profile.userSettings, { onDelete: "CASCADE" })
  @JoinColumn({ name: "profile_id" })
  profile!: UserSettingProfile;

  @Column({ length: 100 })
  type!: string;

  @Column({ length: 100 })
  code!: string;

  @Column({ type: "text" })
  value!: string;
}
