import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Setting } from "../../settings/setting.entity";
import { UpdateYouTubeSettingsDto } from "../dto/settings.dto";

const SETTING_TYPE = "youtube";

export interface YouTubeSettings {
  geminiModel: string;
  temperature: number;
  trendsRegion: string;
  analyticsSyncInterval: number;
  trendsSyncInterval: number;
}

const DEFAULTS: YouTubeSettings = {
  geminiModel: "gemini-2.5-pro",
  temperature: 0.2,
  trendsRegion: "VN",
  analyticsSyncInterval: 6,
  trendsSyncInterval: 24,
};

@Injectable()
export class YouTubeSettingsService {
  constructor(
    @InjectRepository(Setting, "tool")
    private readonly settingRepo: Repository<Setting>,
  ) {}

  async getSettings(userId: string): Promise<YouTubeSettings> {
    const settings = await this.settingRepo.find({
      where: { type: `${SETTING_TYPE}:${userId}` },
    });

    const result = { ...DEFAULTS };

    for (const setting of settings) {
      switch (setting.code) {
        case "geminiModel":
          result.geminiModel = setting.value;
          break;
        case "temperature":
          result.temperature = parseFloat(setting.value);
          break;
        case "trendsRegion":
          result.trendsRegion = setting.value;
          break;
        case "analyticsSyncInterval":
          result.analyticsSyncInterval = parseInt(setting.value, 10);
          break;
        case "trendsSyncInterval":
          result.trendsSyncInterval = parseInt(setting.value, 10);
          break;
      }
    }

    return result;
  }

  async updateSettings(userId: string, dto: UpdateYouTubeSettingsDto): Promise<YouTubeSettings> {
    const type = `${SETTING_TYPE}:${userId}`;
    const updates: Array<{ code: string; value: string }> = [];

    if (dto.geminiModel !== undefined) updates.push({ code: "geminiModel", value: dto.geminiModel });
    if (dto.temperature !== undefined) updates.push({ code: "temperature", value: String(dto.temperature) });
    if (dto.trendsRegion !== undefined) updates.push({ code: "trendsRegion", value: dto.trendsRegion });
    if (dto.analyticsSyncInterval !== undefined) updates.push({ code: "analyticsSyncInterval", value: String(dto.analyticsSyncInterval) });
    if (dto.trendsSyncInterval !== undefined) updates.push({ code: "trendsSyncInterval", value: String(dto.trendsSyncInterval) });

    for (const { code, value } of updates) {
      const existing = await this.settingRepo.findOne({ where: { type, code } });
      if (existing) {
        existing.value = value;
        await this.settingRepo.save(existing);
      } else {
        await this.settingRepo.save(this.settingRepo.create({ type, code, value }));
      }
    }

    return this.getSettings(userId);
  }
}
