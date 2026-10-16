import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, UnrecoverableError } from "bullmq";

import { FACEBOOK_PUBLISH_QUEUE } from "./facebook.types";
import { FacebookProviderError } from "./facebook-provider.adapter";
import { FacebookPublishRunner } from "./facebook-publish.runner";

@Processor(FACEBOOK_PUBLISH_QUEUE, {
  concurrency: 1,
  lockDuration: 600_000,
  stalledInterval: 60_000,
  maxStalledCount: 1,
})
export class FacebookProcessor extends WorkerHost {
  private readonly logger = new Logger(FacebookProcessor.name);

  constructor(private readonly runner: FacebookPublishRunner) {
    super();
  }

  async process(job: Job<{ postId: string }>): Promise<void> {
    try {
      await this.runner.run(job.data.postId);
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      const providerError =
        error instanceof FacebookProviderError
          ? error
          : new FacebookProviderError("PUBLISH_FAILED", false, false, false);
      const attempts = Number(job.opts.attempts ?? 1);
      const willRetry = providerError.retryable && !providerError.uncertain && job.attemptsMade + 1 < attempts;
      this.logger.warn(`Facebook job failed post=${job.data.postId} retry=${willRetry} code=${providerError.code}`);
      if (willRetry) throw error;
      await this.runner.giveUp(job.data.postId, providerError);
      throw new UnrecoverableError("Facebook publish stopped");
    }
  }
}
