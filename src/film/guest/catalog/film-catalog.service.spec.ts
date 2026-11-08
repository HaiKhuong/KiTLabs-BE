import { DataSource } from "typeorm";
import { FilmCatalogService } from "./film-catalog.service";

describe("FilmCatalogService banner queries", () => {
  const queryBuilder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    skip: jest.fn(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getOne: jest.fn(),
  };
  const repository = { createQueryBuilder: jest.fn() };
  const dataSource = { getRepository: jest.fn() };
  let service: FilmCatalogService;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.values(queryBuilder).forEach((mock) => mock.mockReturnValue(queryBuilder));
    repository.createQueryBuilder.mockReturnValue(queryBuilder);
    dataSource.getRepository.mockReturnValue(repository);
    service = new FilmCatalogService(dataSource as unknown as DataSource);
  });

  it.each([undefined, "newest"])(
    "sorts the public movie catalog by latest episode update for sort=%s",
    async (sort) => {
      queryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.publicMovies({ sort });

      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        expect.stringContaining("SELECT MAX(episode.updated_at)"),
        "DESC",
        "NULLS LAST",
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        expect.stringContaining("episode.deleted_at IS NULL"),
        "DESC",
        "NULLS LAST",
      );
      expect(queryBuilder.addOrderBy).toHaveBeenNthCalledWith(1, "m.createdAt", "DESC");
      expect(queryBuilder.addOrderBy).toHaveBeenNthCalledWith(2, "m.id", "DESC");
    },
  );

  it("accepts open-ended schedules when listing active banners", async () => {
    queryBuilder.getMany.mockResolvedValue([]);

    await service.banners();

    expect(queryBuilder.where).toHaveBeenCalledWith("banner.isActive = :isActive", {
      isActive: true,
    });
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "(banner.startTime IS NULL OR banner.startTime <= :now)",
      expect.objectContaining({ now: expect.any(Date) }),
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "(banner.endTime IS NULL OR banner.endTime >= :now)",
      expect.objectContaining({ now: expect.any(Date) }),
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("banner.displayOrder", "ASC");
    expect(queryBuilder.getMany).toHaveBeenCalledTimes(1);
  });

  it("returns only the highest-priority active popup banner", async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await service.popupBanner();

    expect(queryBuilder.andWhere).toHaveBeenCalledWith("banner.position = :position", {
      position: "POPUP",
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("banner.displayOrder", "ASC");
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith("banner.createdAt", "DESC");
    expect(queryBuilder.getOne).toHaveBeenCalledTimes(1);
  });
});
