import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

@WebSocketGateway({ cors: { origin: "*" } })
export class TranslateGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    const userId = typeof client.handshake.auth?.userId === "string" ? client.handshake.auth.userId : null;
    if (userId) {
      client.join(`user:${userId}`);
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
