import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { spawn } from "child_process";
import { resolve } from "path";

import { MovieTrend } from "../entities/movie-trend.entity";
import { RedisService } from "../../../database/redis.service";

interface TrendResult {
  keyword: string;
  trendScore: number;
  searchVolume: number;
  relatedQueries: Record<string, unknown>;
}

@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name);
  private readonly CACHE_PREFIX = "youtube:trends:";
  private readonly CACHE_TTL = 24 * 60 * 60; // 24 hours

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(MovieTrend, "tool")
    private readonly trendRepo: Repository<MovieTrend>,
    private readonly redisService: RedisService,
  ) {}

  async fetchTrends(keywords: string[], region = "VN"): Promise<TrendResult[]> {
    const cacheKey = `${this.CACHE_PREFIX}${region}:${keywords.sort().join(",")}`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      this.logger.debug(`Trends cache hit for: ${keywords.join(", ")}`);
      return JSON.parse(cached);
    }

    const results = await this.executePythonTrends(keywords, region);

    await this.redisService.set(cacheKey, JSON.stringify(results), this.CACHE_TTL);

    return results;
  }

  async saveTrends(movieId: string, results: TrendResult[], region: string): Promise<MovieTrend[]> {
    const today = new Date().toISOString().split("T")[0];
    const trends: MovieTrend[] = [];

    for (const result of results) {
      const existing = await this.trendRepo.findOne({
        where: { movieId, date: today, keyword: result.keyword },
      });

      if (existing) {
        existing.trendScore = result.trendScore;
        existing.searchVolume = result.searchVolume;
        existing.relatedQueries = result.relatedQueries;
        trends.push(await this.trendRepo.save(existing));
      } else {
        const trend = this.trendRepo.create({
          movieId,
          date: today,
          trendScore: result.trendScore,
          searchVolume: result.searchVolume,
          region,
          keyword: result.keyword,
          relatedQueries: result.relatedQueries,
        });
        trends.push(await this.trendRepo.save(trend));
      }
    }

    return trends;
  }

  async getMovieTrends(movieId: string, days = 30): Promise<MovieTrend[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.trendRepo
      .createQueryBuilder("trend")
      .where("trend.movie_id = :movieId", { movieId })
      .andWhere("trend.date >= :startDate", { startDate: startDate.toISOString().split("T")[0] })
      .orderBy("trend.date", "ASC")
      .getMany();
  }

  private executePythonTrends(keywords: string[], region: string): Promise<TrendResult[]> {
    return new Promise((resolve_, reject) => {
      const pythonBin = this.configService.get("TRENDS_PYTHON_BIN") ?? "python";
      const scriptPath = this.configService.get("TRENDS_PYTHON_SCRIPT") ?? "tools/trends/fetch_trends.py";
      const fullPath = resolve(process.cwd(), scriptPath);

      const args = [fullPath, "--keywords", JSON.stringify(keywords), "--region", region];

      this.logger.log(`Running trends script: ${pythonBin} ${args.join(" ")}`);

      const child = spawn(pythonBin, args, {
        cwd: process.cwd(),
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          this.logger.error(`Trends script failed (code=${code}): ${stderr}`);
          reject(new Error(`Trends script exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const results = JSON.parse(stdout.trim());
          resolve_(results);
        } catch (err) {
          this.logger.error(`Failed to parse trends output: ${stdout}`);
          reject(new Error("Failed to parse trends script output"));
        }
      });

      child.on("error", (err) => {
        this.logger.error(`Failed to spawn trends script: ${err.message}`);
        reject(err);
      });
    });
  }
}
