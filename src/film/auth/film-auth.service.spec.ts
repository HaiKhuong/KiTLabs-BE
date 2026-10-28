import { JwtService } from "@nestjs/jwt";
import { DataSource } from "typeorm";
import { FilmItem, FilmUser, FilmUserInventory, ItemType } from "../entities/film.entities";
import { FilmAuthService } from "./film-auth.service";

describe("FilmAuthService.profile", () => {
  const user = { id: "user-1", name: "Dao huu", currentTitle: "legacy-title" } as FilmUser;

  function setup(currentTitle: string | null | undefined) {
    const query = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue(currentTitle === undefined ? undefined : { currentTitle }),
    };
    const userRepository = { findOneByOrFail: jest.fn().mockResolvedValue(user) };
    const inventoryRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const db = {
      getRepository: jest.fn((entity) => {
        if (entity === FilmUser) return userRepository;
        if (entity === FilmUserInventory) return inventoryRepository;
        throw new Error("Unexpected repository");
      }),
    } as unknown as DataSource;
    const service = new FilmAuthService(db, db, {} as JwtService);

    return { service, query, userRepository, inventoryRepository };
  }

  it("returns the equipped TITLE slug instead of users.current_title", async () => {
    const { service, query } = setup("kim_dan_so_ky");

    await expect(service.profile(user.id)).resolves.toEqual({
      ...user,
      currentTitle: "kim_dan_so_ky",
    });
    expect(query.innerJoin).toHaveBeenCalledWith(FilmItem, "item", "item.id = inventory.itemId");
    expect(query.select).toHaveBeenCalledWith("item.assetConfig ->> 'slug'", "currentTitle");
    expect(query.where).toHaveBeenCalledWith("inventory.userId = :userId", { userId: user.id });
    expect(query.andWhere).toHaveBeenCalledWith("inventory.isEquipped = true");
    expect(query.andWhere).toHaveBeenCalledWith("item.type = :type", { type: ItemType.TITLE });
    expect(query.orderBy).toHaveBeenCalledWith("inventory.acquiredAt", "DESC");
    expect(query.addOrderBy).toHaveBeenCalledWith("inventory.updatedAt", "DESC");
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["no equipped TITLE", undefined],
    ["an equipped TITLE without asset_config.slug", null],
  ])("returns null when there is %s", async (_description, currentTitle) => {
    const { service } = setup(currentTitle);

    await expect(service.profile(user.id)).resolves.toEqual({ ...user, currentTitle: null });
  });

  it("preserves the existing not-found behavior", async () => {
    const { service, userRepository, inventoryRepository } = setup("unused");
    const error = new Error("User not found");
    userRepository.findOneByOrFail.mockRejectedValue(error);

    await expect(service.profile(user.id)).rejects.toBe(error);
    expect(inventoryRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe("updateProfile", () => {
    it("updates the user name and returns profile", async () => {
      const { service, userRepository } = setup("kim_dan_so_ky");
      userRepository.save = jest.fn().mockImplementation((u) => Promise.resolve(u));

      const updated = await service.updateProfile(user.id, { name: "Tiêu Viêm" });
      expect(userRepository.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Tiêu Viêm" }));
      expect(updated.name).toBe("Tiêu Viêm");
    });

    it("rejects invalid name length", async () => {
      const { service } = setup("kim_dan_so_ky");
      await expect(service.updateProfile(user.id, { name: "A" })).rejects.toThrow();
    });
  });
});
