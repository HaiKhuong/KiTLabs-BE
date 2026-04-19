import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { User } from "../users/user.entity";
import { CreateUserSettingProfileDto } from "./dto/create-user-setting-profile.dto";
import { UpsertSettingDto } from "./dto/upsert-setting.dto";
import { UpsertUserSettingDto } from "./dto/upsert-user-setting.dto";
import { Setting } from "./setting.entity";
import { UserSettingProfile } from "./user-setting-profile.entity";
import { UserSetting } from "./user-setting.entity";

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting, "tool")
    private readonly settingRepository: Repository<Setting>,
    @InjectRepository(UserSetting, "tool")
    private readonly userSettingRepository: Repository<UserSetting>,
    @InjectRepository(UserSettingProfile, "tool")
    private readonly userSettingProfileRepository: Repository<UserSettingProfile>,
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
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const profile = await this.resolveProfile(dto.userId, dto.type, dto.profileId);

    const existed = await this.userSettingRepository.findOne({
      where: { profileId: profile.id, type: dto.type, code: dto.code },
    });
    if (existed) {
      existed.value = dto.value;
      return this.userSettingRepository.save(existed);
    }

    return this.userSettingRepository.save(
      this.userSettingRepository.create({
        userId: dto.userId,
        profileId: profile.id,
        type: dto.type,
        code: dto.code,
        value: dto.value,
      }),
    );
  }

  async upsertUserSettings(payload: UpsertUserSettingDto | UpsertUserSettingDto[]): Promise<UserSetting[]> {
    const items = Array.isArray(payload) ? payload : [payload];
    if (items.length === 0) {
      return [];
    }

    const savedItems: UserSetting[] = [];
    for (const item of items) {
      savedItems.push(await this.upsertUserSetting(item));
    }
    return savedItems;
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

  async listUserSettings(userId: string, type?: string, profileId?: string): Promise<UserSetting[]> {
    if (profileId) {
      return this.userSettingRepository.find({
        where: { userId, type, profileId },
        order: { createdAt: "DESC" },
      });
    }

    if (!type) {
      return this.userSettingRepository.find({
        where: { userId },
        order: { createdAt: "DESC" },
      });
    }

    const defaultProfile = await this.ensureDefaultProfile(userId, type);
    return this.userSettingRepository.find({
      where: { userId, type, profileId: defaultProfile.id },
      order: { createdAt: "DESC" },
    });
  }

  async listUserSettingProfiles(userId: string, type?: string): Promise<UserSettingProfile[]> {
    if (!type) {
      return this.userSettingProfileRepository.find({
        where: { userId },
        order: { isDefault: "DESC", name: "ASC" },
      });
    }

    await this.ensureDefaultProfile(userId, type);
    return this.userSettingProfileRepository.find({
      where: { userId, type },
      order: { isDefault: "DESC", name: "ASC" },
    });
  }

  async createUserSettingProfile(dto: CreateUserSettingProfileDto): Promise<UserSettingProfile> {
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException("Profile name is required");
    }

    const existed = await this.userSettingProfileRepository.findOne({
      where: { userId: dto.userId, type: dto.type, name },
    });
    if (existed) {
      return existed;
    }

    if (dto.isDefault) {
      await this.userSettingProfileRepository.update(
        { userId: dto.userId, type: dto.type, isDefault: true },
        { isDefault: false },
      );
    }

    return this.userSettingProfileRepository.save(
      this.userSettingProfileRepository.create({
        userId: dto.userId,
        type: dto.type,
        name,
        isDefault: dto.isDefault ?? false,
      }),
    );
  }

  async getValue(type: string, code: string): Promise<string | null> {
    const item = await this.settingRepository.findOne({ where: { type, code } });
    return item?.value ?? null;
  }

  private async resolveProfile(userId: string, type: string, profileId?: string): Promise<UserSettingProfile> {
    if (profileId) {
      const profile = await this.userSettingProfileRepository.findOne({
        where: { id: profileId, userId, type },
      });
      if (!profile) {
        throw new BadRequestException("Profile not found");
      }
      return profile;
    }
    return this.ensureDefaultProfile(userId, type);
  }

  private async ensureDefaultProfile(userId: string, type: string): Promise<UserSettingProfile> {
    const existed = await this.userSettingProfileRepository.findOne({
      where: { userId, type, isDefault: true },
    });
    if (existed) {
      return existed;
    }

    const firstProfile = await this.userSettingProfileRepository.findOne({
      where: { userId, type },
      order: { createdAt: "ASC" },
    });
    if (firstProfile) {
      if (!firstProfile.isDefault) {
        firstProfile.isDefault = true;
        return this.userSettingProfileRepository.save(firstProfile);
      }
      return firstProfile;
    }

    return this.userSettingProfileRepository.save(
      this.userSettingProfileRepository.create({
        userId,
        type,
        name: "Default",
        isDefault: true,
      }),
    );
  }
}
