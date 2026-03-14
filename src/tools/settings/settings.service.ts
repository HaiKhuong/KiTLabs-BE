import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { User } from "../users/user.entity";
import { UpsertSettingDto } from "./dto/upsert-setting.dto";
import { UpsertUserSettingDto } from "./dto/upsert-user-setting.dto";
import { Setting } from "./setting.entity";
import { UserSetting } from "./user-setting.entity";

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting, "tool")
    private readonly settingRepository: Repository<Setting>,
    @InjectRepository(UserSetting, "tool")
    private readonly userSettingRepository: Repository<UserSetting>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
  ) {}

  async upsertSetting(dto: UpsertSettingDto): Promise<Setting> {
    const existed = await this.settingRepository.findOne({
      where: { type: dto.type, code: dto.code },
    });
    if (existed) {
      existed.value = dto.value;
      return this.settingRepository.save(existed);
    }
    return this.settingRepository.save(this.settingRepository.create(dto));
  }

  async upsertUserSetting(dto: UpsertUserSettingDto): Promise<UserSetting> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const existed = await this.userSettingRepository.findOne({
      where: { userId: dto.userId, type: dto.type, code: dto.code },
    });
    if (existed) {
      existed.value = dto.value;
      return this.userSettingRepository.save(existed);
    }

    return this.userSettingRepository.save(
      this.userSettingRepository.create({
        userId: dto.userId,
        type: dto.type,
        code: dto.code,
        value: dto.value,
      }),
    );
  }

  async listSettings(type?: string): Promise<Setting[]> {
    if (!type) {
      return this.settingRepository.find({ order: { createdAt: "DESC" } });
    }
    return this.settingRepository.find({
      where: { type },
      order: { createdAt: "DESC" },
    });
  }

  async listUserSettings(userId: string): Promise<UserSetting[]> {
    return this.userSettingRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async getValue(type: string, code: string): Promise<string | null> {
    const item = await this.settingRepository.findOne({ where: { type, code } });
    return item?.value ?? null;
  }
}
