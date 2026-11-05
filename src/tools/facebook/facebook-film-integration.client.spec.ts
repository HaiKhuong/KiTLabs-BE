import { facebookEmbedUrl, facebookPermalink } from "./facebook-film-integration.client";
import { FacebookContentKind } from "./facebook.types";

describe("facebookPermalink", () => {
  it("builds a page video permalink", () => {
    expect(facebookPermalink(FacebookContentKind.VIDEO, "123", "456")).toBe(
      "https://www.facebook.com/123/videos/456/",
    );
  });

  it("builds a reel permalink", () => {
    expect(facebookPermalink(FacebookContentKind.REEL, "123", "456")).toBe(
      "https://www.facebook.com/reel/456/",
    );
  });

  it("builds the Facebook video plugin URL used by Film sources", () => {
    expect(facebookEmbedUrl(FacebookContentKind.REEL, "123", "1852639132414028")).toBe(
      "https://www.facebook.com/plugins/video.php?height=314&href=https%3A%2F%2Fwww.facebook.com%2Freel%2F1852639132414028%2F&show_text=false&width=560&t=0",
    );
  });
});
