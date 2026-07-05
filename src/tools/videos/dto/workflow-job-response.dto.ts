export type WorkflowJobQueuedResponse = {
  jobId: string;
  nodeId: string;
  type: "ai_task" | "voice" | "image";
  status: "queued";
};
