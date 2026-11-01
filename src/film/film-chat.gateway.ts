import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { RedisService } from "../database/redis.service";
import { ChatType } from "./entities/film.entities";
import { isFilmEmojiId } from "./film-emojis.constants";
import { FilmChatService } from "./guest/chat/film-chat.service";

export const FILM_MISSION_REWARD_EVENT = "mission.reward.claimed";

export interface FilmMissionRewardEvent {
  missionCode: string;
  claimedExp: number;
  newTotalExp: string;
  newSectRank: string;
  message: string;
  claimedAt: string;
}

@WebSocketGateway({ namespace: "/film-chat", cors: { origin: "*" } })
export class FilmChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(FilmChatGateway.name);
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly jwt: JwtService,
    private readonly chatService: FilmChatService,
    private readonly redis: RedisService,
  ) {}

  async handleConnection(client: Socket) {
    const raw =
      typeof client.handshake.auth?.token === "string"
        ? client.handshake.auth.token
        : String(client.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let userId: string;
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; tokenType: string }>(raw, {
        secret: process.env.FILM_JWT_ACCESS_SECRET || "film_access_secret_change_me",
      });
      if (!p.sub || p.tokenType !== "access") throw new Error();
      userId = p.sub;
    } catch {
      client.disconnect(true);
      return;
    }

    client.data.userId = userId;
    await client.join(this.userRoom(userId));
    try {
      await this.flushPendingMissionRewards(client, userId);
    } catch (error) {
      this.logger.warn(`Failed to flush pending mission rewards for user ${userId}: ${(error as Error).message}`);
    }
  }

  async notifyMissionReward(userId: string, payload: FilmMissionRewardEvent): Promise<void> {
    const room = this.userRoom(userId);
    const sockets = await this.server.in(room).fetchSockets();

    if (sockets.length > 0) {
      this.server.to(room).emit(FILM_MISSION_REWARD_EVENT, payload);
      return;
    }

    const key = this.pendingMissionRewardKey(userId);
    await this.redis.rpush(key, JSON.stringify(payload));
    await this.redis.expire(key, 86_400);
  }

  async handleDisconnect(client: Socket) {
    const rooms = Array.isArray(client.data.chatRooms) ? (client.data.chatRooms as string[]) : [];
    await Promise.all(rooms.map((room) => this.emitPresence(room)));
  }

  @SubscribeMessage("join")
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { room?: string }) {
    const room = (body.room || "WORLD_GENERAL").slice(0, 100);
    await client.join(room);
    client.data.chatRooms = [...new Set([...(client.data.chatRooms || []), room])];
    const onlineCount = await this.emitPresence(room);
    return { room, onlineCount };
  }

  @SubscribeMessage("message")
  async message(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: string; message?: string; type?: string },
  ) {
    const userId = String(client.data.userId || "");
    const now = Date.now();
    const times = (this.recent.get(userId) || []).filter((x) => now - x < 10_000);

    if (times.length >= 5) return { error: "RATE_LIMITED" };

    const type = body.type ?? ChatType.TEXT;
    if (type !== ChatType.TEXT && type !== ChatType.EMOJI) {
      return { error: "INVALID_MESSAGE" };
    }

    const message = body.message?.trim();
    if (!message || message.length > 1000) return { error: "INVALID_MESSAGE" };
    if (type === ChatType.EMOJI && !isFilmEmojiId(message)) {
      return { error: "INVALID_MESSAGE" };
    }

    times.push(now);
    this.recent.set(userId, times);
    const room = (body.room || "WORLD_GENERAL").slice(0, 100);

    const saved = await this.chatService.createChat(userId, room, message, type);
    this.server.to(room).emit("message", saved);
    return saved;
  }

  private async emitPresence(room: string) {
    const sockets = await this.server.in(room).fetchSockets();
    const onlineCount = new Set(sockets.map((socket) => String(socket.data.userId || socket.id))).size;
    this.server.to(room).emit("presence", { room, onlineCount });
    return onlineCount;
  }

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private pendingMissionRewardKey(userId: string): string {
    return `film:mission:reward_notifications:${userId}`;
  }

  private async flushPendingMissionRewards(client: Socket, userId: string): Promise<void> {
    const key = this.pendingMissionRewardKey(userId);
    const pending = await this.redis.lrange(key, 0, -1);
    if (pending.length === 0) return;

    await this.redis.del(key);
    for (const serialized of pending) {
      try {
        client.emit(FILM_MISSION_REWARD_EVENT, JSON.parse(serialized) as FilmMissionRewardEvent);
      } catch {
        // Ignore malformed or stale queue entries without rejecting the socket connection.
      }
    }
  }
}
