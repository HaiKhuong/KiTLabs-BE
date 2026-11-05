import { FilmEpisodeSource, FilmMovie } from "../entities/film.entities";
import { FilmFacebookIntegrationService } from "./film-facebook-integration.service";
import { FilmFacebookKind } from "./film-facebook-integration.dto";

describe("FilmFacebookIntegrationService", () => {
  it("returns the existing source when the Facebook post was already synced", async () => {
    const movie = { id: "11111111-1111-4111-8111-111111111111" };
    const existing = {
      id: "22222222-2222-4222-8222-222222222222",
      episodeId: "33333333-3333-4333-8333-333333333333",
      videoUrl: "https://www.facebook.com/1/videos/2/",
    };
    const movieRepo = { findOne: jest.fn().mockResolvedValue(movie) };
    const sourceRepo = { findOne: jest.fn().mockResolvedValue(existing) };
    const manager = {
      getRepository: jest.fn((entity) => entity === FilmMovie ? movieRepo : entity === FilmEpisodeSource ? sourceRepo : {}),
    };
    const db = { transaction: jest.fn((work) => work(manager)) };
    const service = new FilmFacebookIntegrationService(db as never);

    const result = await service.syncFacebookPost({
      facebookPostUuid: "44444444-4444-4444-8444-444444444444",
      facebookObjectId: "2",
      pageGraphId: "1",
      kind: FilmFacebookKind.VIDEO,
      movieId: movie.id,
      episodeNumber: 1,
      title: "Tập 1",
      permalink: existing.videoUrl,
    });

    expect(result).toEqual({
      episodeId: existing.episodeId,
      sourceId: existing.id,
      videoUrl: existing.videoUrl,
      createdEpisode: false,
      createdSource: false,
    });
    expect(sourceRepo.findOne).toHaveBeenCalledWith({
      where: { externalProvider: "facebook", externalReference: "44444444-4444-4444-8444-444444444444" },
    });
  });
});
