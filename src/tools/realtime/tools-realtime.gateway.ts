import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { JwtService } from "@nestjs/jwt";
import { Server, Socket } from "socket.io";

@WebSocketGateway({ cors: { origin: "*" } })
export class ToolsRealtimeGateway implements OnGatewayConnection {
  constructor(private readonly jwtService: JwtService) {}

  @WebSocketServer()
  server!: Server;

  async handleConnection(client: Socket): Promise<void> {
    const authToken = typeof client.handshake.auth?.token === "string" ? client.handshake.auth.token : "";
    const authorization =
      typeof client.handshake.headers.authorization === "string" ? client.handshake.headers.authorization : "";
    const token = authToken || authorization.replace(/^Bearer\s+/i, "");
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwtService.verifyAsync<{ sub?: string }>(token, {
        secret: process.env.JWT_ACCESS_SECRET ?? "access_secret",
      });
      if (!payload.sub) throw new Error("Missing subject");
      client.data.userId = payload.sub;
      await client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  notifyUser(userId: string, event: string, payload: Record<string, unknown>) {
    if (userId === "all") {
      this.server.emit(event, payload);
      return;
    }
    this.server.to(`user:${userId}`).emit(event, payload);
  }
}
