import { JwtService } from "@nestjs/jwt";
import { Server, Socket } from "socket.io";
import { ChatType } from "./entities/film.entities";
import { FilmChatGateway } from "./film-chat.gateway";
import { FilmChatService } from "./guest/chat/film-chat.service";

describe("FilmChatGateway.message", () => {
  const client = { data: { userId: "user-1" } } as unknown as Socket;
  let createChat: jest.Mock;
  let emit: jest.Mock;
  let gateway: FilmChatGateway;

  beforeEach(() => {
    createChat = jest.fn().mockImplementation((_userId, room, message, type) =>
      Promise.resolve({
        id: "message-1",
        roomChannel: room,
        message,
        type,
      }),
    );
    emit = jest.fn();
    gateway = new FilmChatGateway({} as JwtService, { createChat } as unknown as FilmChatService);
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit }),
    } as unknown as Server;
  });

  it("defaults legacy payloads without a type to TEXT", async () => {
    await expect(gateway.message(client, { message: "  Xin chào  " })).resolves.toEqual(
      expect.objectContaining({ message: "Xin chào", type: ChatType.TEXT }),
    );
    expect(createChat).toHaveBeenCalledWith("user-1", "WORLD_GENERAL", "Xin chào", ChatType.TEXT);
    expect(emit).toHaveBeenCalledWith("message", expect.objectContaining({ message: "Xin chào", type: ChatType.TEXT }));
  });

  it("saves a known emoji with the EMOJI type", async () => {
    await expect(gateway.message(client, { message: "bai_phuc_01", type: ChatType.EMOJI })).resolves.toEqual(
      expect.objectContaining({ message: "bai_phuc_01", type: ChatType.EMOJI }),
    );
    expect(createChat).toHaveBeenCalledWith("user-1", "WORLD_GENERAL", "bai_phuc_01", ChatType.EMOJI);
  });

  it.each([
    ["an unknown emoji", { message: "unknown_emoji", type: ChatType.EMOJI }],
    ["a sticker type", { message: "bai_phuc_01", type: ChatType.STICKER }],
    ["a system announcement type", { message: "bai_phuc_01", type: ChatType.SYSTEM_ANNOUNCEMENT }],
  ])("rejects %s from clients", async (_description, payload) => {
    await expect(gateway.message(client, payload)).resolves.toEqual({
      error: "INVALID_MESSAGE",
    });
    expect(createChat).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
