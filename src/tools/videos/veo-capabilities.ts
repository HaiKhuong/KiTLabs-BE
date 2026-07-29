import { VEO_MODELS, type VeoModel } from "./dto/generate-veo-video.dto";

export type VeoCapabilities = {
  models: readonly VeoModel[];
  defaultModel: VeoModel;
  modes: readonly string[];
  parameters: {
    prompt: { supported: true; required: true };
    aspectRatio: { supported: true; options: readonly ["16:9", "9:16"]; default: "16:9" };
    durationSeconds: { supported: true; options: readonly [4, 6, 8]; default: 8 };
    resolution: { supported: true; options: readonly ["720p", "1080p", "4k"]; default: "720p" };
    personGeneration: {
      supported: true;
      options: readonly ["allow_all", "allow_adult", "dont_allow"];
      rules: {
        textToVideo: "allow_all";
        imageToVideo: "allow_adult";
        referenceImages: "allow_adult";
        extension: "allow_all";
      };
    };
    seed: { supported: true };
    firstFrame: { supported: true };
    lastFrame: { supported: true; requiresFirstFrame: true };
    referenceImages: { supported: true; maxItems: 3; referenceType: "asset" };
    extendVideo: { supported: true; maxExtensions: 20; extensionSeconds: 7 };
  };
  constraints: readonly string[];
  apiKeyTiers: readonly ["normal", "vip"];
};

export function buildVeoCapabilities(defaultModel: VeoModel): VeoCapabilities {
  return {
    models: VEO_MODELS,
    defaultModel,
    modes: ["text-to-video", "image-to-video", "reference-images", "first-last-frame", "extend-video"],
    parameters: {
      prompt: { supported: true, required: true },
      aspectRatio: { supported: true, options: ["16:9", "9:16"], default: "16:9" },
      durationSeconds: { supported: true, options: [4, 6, 8], default: 8 },
      resolution: { supported: true, options: ["720p", "1080p", "4k"], default: "720p" },
      personGeneration: {
        supported: true,
        options: ["allow_all", "allow_adult", "dont_allow"],
        rules: {
          textToVideo: "allow_all",
          imageToVideo: "allow_adult",
          referenceImages: "allow_adult",
          extension: "allow_all",
        },
      },
      seed: { supported: true },
      firstFrame: { supported: true },
      lastFrame: { supported: true, requiresFirstFrame: true },
      referenceImages: { supported: true, maxItems: 3, referenceType: "asset" },
      extendVideo: { supported: true, maxExtensions: 20, extensionSeconds: 7 },
    },
    constraints: [
      "referenceImages cannot be combined with firstFrame",
      "extendVideo cannot be combined with firstFrame, lastFrame, or referenceImages",
      "durationSeconds must be 8 when using referenceImages, extendVideo, 1080p, or 4k",
      "extendVideo only supports 720p resolution",
      "veo-3.1-lite-generate-preview does not support referenceImages, extendVideo, or 4k",
      "Generated videos are retained by Google for about 2 days",
    ],
    apiKeyTiers: ["normal", "vip"],
  };
}
