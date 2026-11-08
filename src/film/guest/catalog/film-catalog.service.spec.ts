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
  const dataSource = { getRepository: jest.fn(), createQueryBuilder: jest.fn() };
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

  it("counts only episodes that have an active source", async () => {
    const movie = { id: "movie-1", currentEpisodeCount: 1 };
    const createRawQueryBuilder = (rows: unknown[]) => {
      const rawQueryBuilder = {
        select: jest.fn(),
        addSelect: jest.fn(),
        from: jest.fn(),
        innerJoin: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        groupBy: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      Object.values(rawQueryBuilder).forEach((mock) => {
        if (mock !== rawQueryBuilder.getRawMany) mock.mockReturnValue(rawQueryBuilder);
      });
      return rawQueryBuilder;
    };
    const genreQuery = createRawQueryBuilder([]);
    const episodeCountQuery = createRawQueryBuilder([{ movieId: movie.id, episodeCount: "7" }]);
    dataSource.createQueryBuilder.mockReturnValueOnce(genreQuery).mockReturnValueOnce(episodeCountQuery);
    queryBuilder.getManyAndCount.mockResolvedValue([[movie], 1]);

    const result = await service.publicMovies({});

    expect(result.items[0].currentEpisodeCount).toBe(7);
    expect(episodeCountQuery.innerJoin).toHaveBeenCalledWith(
      expect.anything(),
      "source",
      expect.stringContaining("source.is_active = :sourceActive"),
      { sourceActive: true },
    );
    expect(episodeCountQuery.andWhere).toHaveBeenCalledWith("episode.deleted_at IS NULL");
  });

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
