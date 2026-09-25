import { BadRequestException } from "@nestjs/common";

import { calculateChunkPlan, calculateChunkSize } from "./tiktok-provider.adapter";
import { CommercialDisclosure, mapCommercialDisclosure } from "./tiktok.types";
import { validateTikTokVideo } from "./tiktok-video.validation";

describe("TikTok MVP domain rules", () => {
  describe("commercial disclosure mapper", () => {
    it.each([
      [CommercialDisclosure.NONE, false, false],
      [CommercialDisclosure.ORGANIC_BRAND, true, false],
      [CommercialDisclosure.BRANDED_CONTENT, false, true],
      [CommercialDisclosure.BOTH, true, true],
    ])("maps %s to provider-owned booleans", (value, organic, branded) => {
      expect(mapCommercialDisclosure(value)).toEqual({
        brand_organic_toggle: organic,
        brand_content_toggle: branded,
      });
    });
  });

  describe("provider video validation", () => {
    const valid = {
      format: "mp4",
      codec: "h264",
      sizeBytes: 20_000_000,
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 30,
    };

    it("accepts a documented TikTok video", () => {
      expect(() => validateTikTokVideo(valid, 60)).not.toThrow();
    });

    it("keeps provider provenance on a TikTok rule", () => {
      try {
        validateTikTokVideo({ ...valid, fps: 61 });
        throw new Error("expected validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          source: "tiktok",
          code: "FPS_OUT_OF_RANGE",
        });
      }
    });

    it("honors the creator duration limit", () => {
      expect(() => validateTikTokVideo({ ...valid, durationSeconds: 61 }, 60)).toThrow(BadRequestException);
    });
  });

  describe("FILE_UPLOAD chunk sizing", () => {
    it("uses a single chunk for a small upload", () => {
      expect(calculateChunkSize(4 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    });

    it("keeps regular chunks in the documented range", () => {
      const chunk = calculateChunkSize(500 * 1024 * 1024);
      expect(chunk).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      expect(chunk).toBeLessThanOrEqual(64 * 1024 * 1024);
    });

    it("uses multiple chunks once the file exceeds 64 MB", () => {
      expect(calculateChunkPlan(65 * 1024 * 1024).totalChunkCount).toBeGreaterThanOrEqual(2);
    });

    it("merges trailing bytes into the final chunk", () => {
      const total = 130 * 1024 * 1024;
      const plan = calculateChunkPlan(total);
      expect(plan.totalChunkCount).toBe(Math.floor(total / plan.chunkSize));
      const finalChunkBytes = total - plan.chunkSize * (plan.totalChunkCount - 1);
      expect(finalChunkBytes).toBeGreaterThanOrEqual(plan.chunkSize);
      expect(finalChunkBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    });
  });
});
