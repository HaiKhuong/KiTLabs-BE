import { join, resolve } from "path";

import { AUDIO_DATA_ROOT } from "../audio/audio.constants";

/** On-disk folder name kept for existing data compatibility. */
export const WORKFLOW_IMAGES_OUTPUT_DIR = join(AUDIO_DATA_ROOT, "video-images");

export const COMFYUI_DEFAULT_URL = "http://127.0.0.1:8188";

export const DEFAULT_IMAGE_MODEL = "z-image-turbo";

export type ComfyWorkflowNodeIds = {
  positivePrompt: string;
  negativePrompt: string;
  latentImage: string;
  sampler: string;
  saveImage: string;
};

export type ComfyModelWorkflowConfig = {
  /** Workflow JSON path relative to project root */
  workflowPath: string;
  nodes: ComfyWorkflowNodeIds;
};

/**
 * Map FE model option → ComfyUI workflow.
 * Thêm model mới: tạo workflow_api.json tương ứng và khai báo ở đây.
 */
export const IMAGE_MODEL_WORKFLOWS: Record<string, ComfyModelWorkflowConfig> = {
  "z-image-turbo": {
    workflowPath: "tools/comfyui/workflow_api.json",
    nodes: {
      positivePrompt: "67",
      negativePrompt: "71",
      latentImage: "68",
      sampler: "70",
      saveImage: "9",
    },
  },
};

export function resolveComfyuiUrl(): string {
  return (process.env.COMFYUI_URL ?? COMFYUI_DEFAULT_URL).trim();
}

export function resolveComfyuiWebSocketUrl(clientId: string): string {
  const httpUrl = resolveComfyuiUrl().replace(/\/+$/, "");
  const wsBase = httpUrl.startsWith("https://")
    ? `wss://${httpUrl.slice("https://".length)}`
    : httpUrl.startsWith("http://")
      ? `ws://${httpUrl.slice("http://".length)}`
      : `ws://${httpUrl}`;
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

export function resolveImageModel(model?: string): string {
  const defaultModel = (process.env.IMAGE_DEFAULT_MODEL ?? DEFAULT_IMAGE_MODEL).trim().toLowerCase();
  const raw = (model ?? defaultModel).trim().toLowerCase();

  if (raw === "zimage" || raw === "z-image" || raw === "zimageturbo") {
    return DEFAULT_IMAGE_MODEL;
  }

  if (IMAGE_MODEL_WORKFLOWS[raw]) {
    return raw;
  }

  return IMAGE_MODEL_WORKFLOWS[defaultModel] ? defaultModel : DEFAULT_IMAGE_MODEL;
}

export function resolveModelWorkflowConfig(model?: string): ComfyModelWorkflowConfig {
  const modelId = resolveImageModel(model);
  const config = IMAGE_MODEL_WORKFLOWS[modelId];
  if (!config) {
    throw new Error(`No ComfyUI workflow configured for model "${modelId}"`);
  }
  return config;
}

export function resolveModelWorkflowPath(model?: string): string {
  const config = resolveModelWorkflowConfig(model);
  const envKey = `COMFYUI_WORKFLOW_${resolveImageModel(model).toUpperCase().replace(/-/g, "_")}`;
  const envOverride = (process.env[envKey] ?? "").trim();
  if (envOverride) {
    return resolve(process.cwd(), envOverride);
  }

  const legacyOverride = (process.env.COMFYUI_WORKFLOW_PATH ?? "").trim();
  if (legacyOverride && resolveImageModel(model) === DEFAULT_IMAGE_MODEL) {
    return resolve(process.cwd(), legacyOverride);
  }

  return resolve(process.cwd(), config.workflowPath);
}

export function resolveWorkflowImagesOutputDir(): string {
  const raw = (
    process.env.WORKFLOW_IMAGES_DATA_ROOT ??
    process.env.VIDEO_IMAGES_DATA_ROOT ??
    process.env.IMAGE_DATA_ROOT ??
    ""
  ).trim();
  if (raw) {
    return resolve(raw);
  }
  return resolve(WORKFLOW_IMAGES_OUTPUT_DIR);
}

export function buildSceneImageFilename(sceneNumber: number): string {
  return `scene-${sceneNumber}.png`;
}

export function buildSceneImageRelativeUrl(
  userId: string,
  nodeId: string,
  sceneNumber: number,
): string {
  const filename = buildSceneImageFilename(sceneNumber);
  return `/api/tools/workflow/images/${encodeURIComponent(userId)}/${encodeURIComponent(nodeId)}/${filename}`;
}

export const STUDIO_IMAGE_FILENAME = "output.png";

export function buildStudioImageRelativeUrl(userId: string, jobId: string): string {
  return `/api/tools/images/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/${STUDIO_IMAGE_FILENAME}`;
}
