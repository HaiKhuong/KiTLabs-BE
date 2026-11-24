import { FilmPushPlatform } from "../entities/film.entities";
import { FilmPushService } from "./film-push.service";

describe("FilmPushService", () => {
  const createMockService = () => {
    const repo = {
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => v),
      find: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    const db = {
      getRepository: jest.fn(() => repo),
    } as any;
    const queue = {
      add: jest.fn(async (name, data) => ({ id: "job-1", name, data })),
    } as any;
    const service = new FilmPushService(db, queue);
    return { service, repo, queue };
  };

  it("upserts existing push token and reactivates it for current user/device", async () => {
    const { service, repo } = createMockService();
    const existing = {
      id: "pt-1",
      userId: "old-user",
      deviceId: "old-dev",
      token: "fcm-token-1",
      platform: FilmPushPlatform.WEB,
      userAgent: null,
      isActive: false,
      deletedAt: new Date(),
    };
    repo.findOne.mockResolvedValue(existing);

    const saved = await service.registerToken("new-user", "new-dev", "fcm-token-1", FilmPushPlatform.PWA_IOS, "Safari");

    expect(saved.userId).toBe("new-user");
    expect(saved.deviceId).toBe("new-dev");
    expect(saved.platform).toBe(FilmPushPlatform.PWA_IOS);
    expect(saved.isActive).toBe(true);
    expect(saved.deletedAt).toBeNull();
  });

  it("splits multicast into 500-token batches and deactivates invalid tokens", async () => {
    const { service, repo } = createMockService();
    const tokens = Array.from({ length: 502 }, (_, i) => ({ id: `id-${i}`, token: `tok-${i}` }));
    repo.find.mockResolvedValue(tokens);

    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({
        successCount: 499,
        failureCount: 1,
        responses: [
          { success: false, error: { code: "messaging/registration-token-not-registered" } },
          ...Array.from({ length: 499 }, () => ({ success: true })),
        ],
      })
      .mockResolvedValueOnce({
        successCount: 2,
        failureCount: 0,
        responses: [{ success: true }, { success: true }],
      });

    (service as any).messaging = { sendEachForMulticast };

    const result = await service.dispatchJob({
      kind: "broadcast",
      payload: { title: "Tập mới", body: "Tập 10 đã lên sóng", actionUrl: "/phim/test" },
    });

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toHaveLength(2);
    expect(result).toEqual({ sent: 501, failed: 1, totalTokens: 502 });
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it("checks whether a user has an active FCM token", async () => {
    const { service, repo } = createMockService();
    repo.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.hasActiveTokenForUser("user-1")).resolves.toBe(true);
    await expect(service.hasActiveTokenForUser("user-2")).resolves.toBe(false);
    await expect(service.hasActiveTokenForUser("   ")).resolves.toBe(false);
    expect(repo.count).toHaveBeenNthCalledWith(1, { where: { userId: "user-1", isActive: true } });
    expect(repo.count).toHaveBeenNthCalledWith(2, { where: { userId: "user-2", isActive: true } });
  });
});
