import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { CreateUserSettingProfileDto } from "./dto/create-user-setting-profile.dto";
import { UpdateUserSettingProfileDto } from "./dto/update-user-setting-profile.dto";
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
    if (!dto.userId?.trim()) {
      throw new BadRequestException("userId is required");
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

  async updateUserSettingProfile(id: string, dto: UpdateUserSettingProfileDto): Promise<UserSettingProfile> {
    if (!dto.userId?.trim()) {
      throw new BadRequestException("userId is required");
    }

    const profile = await this.userSettingProfileRepository.findOne({
      where: { id, userId: dto.userId },
    });
    if (!profile) {
      throw new BadRequestException("Profile not found");
    }

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException("Profile name is required");
      }

      const duplicated = await this.userSettingProfileRepository.findOne({
        where: { userId: dto.userId, type: profile.type, name },
      });
      if (duplicated && duplicated.id !== profile.id) {
        throw new BadRequestException("Profile name already exists");
      }
      profile.name = name;
    }

    if (dto.directUrl !== undefined) {
      profile.directUrl = dto.directUrl.trim() || undefined;
    }

    if (dto.isDefault === true) {
      await this.userSettingProfileRepository.update(
        { userId: dto.userId, type: profile.type, isDefault: true },
        { isDefault: false },
      );
      profile.isDefault = true;
    } else if (dto.isDefault === false && profile.isDefault) {
      const otherProfiles = await this.userSettingProfileRepository.count({
        where: { userId: dto.userId, type: profile.type },
      });
      if (otherProfiles <= 1) {
        throw new BadRequestException("Cannot unset default on the only profile");
      }
      profile.isDefault = false;
    }

    return this.userSettingProfileRepository.save(profile);
  }

  async deleteUserSettingProfile(id: string, userId: string): Promise<void> {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }

    const profile = await this.userSettingProfileRepository.findOne({
      where: { id, userId },
    });
    if (!profile) {
      throw new BadRequestException("Profile not found");
    }

    const profileCount = await this.userSettingProfileRepository.count({
      where: { userId, type: profile.type },
    });
    if (profileCount <= 1) {
      throw new BadRequestException("Cannot delete the only profile");
    }

    const wasDefault = profile.isDefault;
    await this.userSettingProfileRepository.remove(profile);

    if (wasDefault) {
      await this.ensureDefaultProfile(userId, profile.type);
    }
  }

  async createUserSettingProfile(dto: CreateUserSettingProfileDto): Promise<UserSettingProfile> {
    if (!dto.userId?.trim()) {
      throw new BadRequestException("userId is required");
    }

    const name = dto.name.trim();
    const directUrl = dto.directUrl?.trim() || undefined;
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
        directUrl,
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
