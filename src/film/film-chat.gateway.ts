import { Logger, UseGuards } from "@nestjs/common";
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
import { FilmChatService } from "./guest/chat/film-chat.service";

@WebSocketGateway({ namespace: "/film-chat", cors: { origin: "*" } })
export class FilmChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly jwt: JwtService,
    private readonly chatService: FilmChatService,
  ) {}

  async handleConnection(client: Socket) {
    const raw =
      typeof client.handshake.auth?.token === "string"
        ? client.handshake.auth.token
        : String(client.handshake.headers.authorization || "").replace(/^Bearer\s+/i, "");
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; tokenType: string }>(raw, {
        secret: process.env.FILM_JWT_ACCESS_SECRET || "film_access_secret_change_me",
      });
      if (!p.sub || p.tokenType !== "access") throw new Error();
      client.data.userId = p.sub;
    } catch {
      client.disconnect(true);
    }
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
    @MessageBody() body: { room?: string; message?: string },
  ) {
    const userId = String(client.data.userId || "");
    const now = Date.now();
    const times = (this.recent.get(userId) || []).filter((x) => now - x < 10_000);

    if (times.length >= 5) return { error: "RATE_LIMITED" };

    const message = body.message?.trim();
    if (!message || message.length > 1000) return { error: "INVALID_MESSAGE" };

    times.push(now);
    this.recent.set(userId, times);
    const room = (body.room || "WORLD_GENERAL").slice(0, 100);

    const saved = await this.chatService.createChat(userId, room, message);
    this.server.to(room).emit("message", saved);
    return saved;
  }

  private async emitPresence(room: string) {
    const sockets = await this.server.in(room).fetchSockets();
    const onlineCount = new Set(sockets.map((socket) => String(socket.data.userId || socket.id))).size;
    this.server.to(room).emit("presence", { room, onlineCount });
    return onlineCount;
  }
}
