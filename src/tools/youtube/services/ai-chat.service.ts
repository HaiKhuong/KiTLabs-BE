import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { AiChatHistory, ChatMessage } from "../entities/ai-chat-history.entity";
import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { Movie } from "../entities/movie.entity";
import { Recommendation } from "../entities/recommendation.entity";
import { AnalyticsSnapshot } from "../entities/analytics-snapshot.entity";
import { AiService } from "../ai/ai.service";

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @InjectRepository(AiChatHistory, "tool")
    private readonly chatRepo: Repository<AiChatHistory>,
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    @InjectRepository(Movie, "tool")
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(Recommendation, "tool")
    private readonly recRepo: Repository<Recommendation>,
    @InjectRepository(AnalyticsSnapshot, "tool")
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    private readonly aiService: AiService,
  ) {}

  async sendMessage(userId: string, message: string, chatId?: string): Promise<{ chatId: string; response: string }> {
    let chat: AiChatHistory;

    if (chatId) {
      const existing = await this.chatRepo.findOne({ where: { id: chatId, userId } });
      if (!existing) throw new NotFoundException("Chat not found");
      chat = existing;
    } else {
      chat = this.chatRepo.create({
        userId,
        title: message.substring(0, 100),
        messages: [],
      });
      chat = await this.chatRepo.save(chat);
    }

    const context = await this.buildContext(userId);
    const history = chat.messages.map((m) => ({ role: m.role, content: m.content }));
    const aiResponse = await this.aiService.chat(context, message, history);

    const userMsg: ChatMessage = { role: "user", content: message, timestamp: new Date().toISOString() };
    const assistantMsg: ChatMessage = { role: "assistant", content: aiResponse.content, timestamp: new Date().toISOString() };

    chat.messages = [...chat.messages, userMsg, assistantMsg];
    await this.chatRepo.save(chat);

    return { chatId: chat.id, response: aiResponse.content };
  }

  async getChatHistory(userId: string): Promise<AiChatHistory[]> {
    return this.chatRepo.find({
      where: { userId, isArchived: false },
      order: { updatedAt: "DESC" },
      select: ["id", "title", "createdAt", "updatedAt"],
    });
  }

  async getChatMessages(userId: string, chatId: string): Promise<AiChatHistory> {
    const chat = await this.chatRepo.findOne({ where: { id: chatId, userId } });
    if (!chat) throw new NotFoundException("Chat not found");
    return chat;
  }

  async deleteChat(userId: string, chatId: string): Promise<void> {
    const chat = await this.chatRepo.findOne({ where: { id: chatId, userId } });
    if (!chat) throw new NotFoundException("Chat not found");
    chat.isArchived = true;
    await this.chatRepo.save(chat);
  }

  private async buildContext(userId: string): Promise<string> {
    const [channel, movies, recommendations, recentAnalytics] = await Promise.all([
      this.channelRepo.findOne({ where: { userId, isActive: true } }),
      this.movieRepo.find({ where: { userId }, take: 50 }),
      this.recRepo.find({ where: { userId, isActive: true }, relations: ["movie"], take: 10 }),
      this.getRecentAnalytics(userId),
    ]);

    const context: Record<string, unknown> = {};

    if (channel) {
      context.channel = {
        name: channel.name,
        subscribers: channel.subscriberCount,
        totalViews: channel.viewCount,
        videos: channel.videoCount,
      };
    }

    context.movies = movies.map((m) => ({
      name: m.chineseName,
      vietnameseName: m.vietnameseName,
      status: m.status,
      score: m.score,
      trendScore: m.trendScore,
      priority: m.priority,
      tags: m.tags,
    }));

    context.activeRecommendations = recommendations.map((r) => ({
      movie: r.movie?.chineseName,
      score: r.score,
      priority: r.priority,
      reason: r.reason,
    }));

    if (recentAnalytics.length > 0) {
      const latest = recentAnalytics[recentAnalytics.length - 1];
      context.recentPerformance = {
        latestDate: latest.date,
        views: latest.views,
        ctr: latest.ctr,
        subscribers: latest.subscribers,
        watchTimeHours: latest.watchTimeHours,
        revenue: latest.revenue,
        daysTracked: recentAnalytics.length,
      };
    }

    return JSON.stringify(context, null, 2);
  }

  private async getRecentAnalytics(userId: string): Promise<AnalyticsSnapshot[]> {
    const channel = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (!channel) return [];

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.channel_id = :channelId", { channelId: channel.id })
      .andWhere("s.date >= :date", { date: sevenDaysAgo.toISOString().split("T")[0] })
      .orderBy("s.date", "ASC")
      .getMany();
  }
}
