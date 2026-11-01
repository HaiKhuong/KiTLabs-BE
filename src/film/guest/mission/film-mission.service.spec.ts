import { FilmMissionService } from "./film-mission.service";

describe("FilmMissionService.recordReferral", () => {
  const referrerUserId = "11111111-1111-4111-8111-111111111111";
  const refereeUserId = "22222222-2222-4222-8222-222222222222";

  function setup() {
    const referralRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const progressRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => value),
    };
    const userRepo = { findOne: jest.fn().mockResolvedValue({ id: referrerUserId }) };
    const service = new FilmMissionService(
      {} as never,
      {} as never,
      progressRepo as never,
      {} as never,
      referralRepo as never,
      userRepo as never,
      {} as never,
      {} as never,
    );
    const autoClaimMission = jest
      .spyOn(service as any, "autoClaimMission")
      .mockResolvedValue(null);

    return { service, referralRepo, progressRepo, autoClaimMission };
  }

  it.each([
    [true, "INCOGNITO_DETECTED", "incognito_detected"],
    [null, "INCOGNITO_UNKNOWN", "incognito_unknown"],
  ] as const)(
    "audits but does not reward an ineligible referral (%s)",
    async (isIncognito, rejectionReason, responseReason) => {
      const { service, referralRepo, progressRepo, autoClaimMission } = setup();

      await expect(
        service.recordReferral(referrerUserId, refereeUserId, "127.0.0.1", "device", isIncognito),
      ).resolves.toEqual({ success: false, reason: responseReason });

      expect(referralRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isRewardEligible: false, rejectionReason }),
      );
      expect(progressRepo.save).not.toHaveBeenCalled();
      expect(autoClaimMission).not.toHaveBeenCalled();
    },
  );

  it("rewards a referral from a confirmed non-private device", async () => {
    const { service, referralRepo, progressRepo, autoClaimMission } = setup();

    await expect(
      service.recordReferral(referrerUserId, refereeUserId, "127.0.0.1", "device", false),
    ).resolves.toEqual({ success: true });

    expect(referralRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isRewardEligible: true, rejectionReason: null }),
    );
    expect(progressRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ missionCode: "SHARE_LINK_REF", currentCount: 1 }),
    );
    expect(autoClaimMission).toHaveBeenCalledWith(referrerUserId, "SHARE_LINK_REF");
  });
});
