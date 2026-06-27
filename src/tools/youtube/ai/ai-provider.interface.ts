export interface AiAnalysisInput {
  channel: {
    name: string;
    subscriberCount: number;
    videoCount: number;
    viewCount: string;
  };
  videos: Array<{
    title: string;
    views: string;
    ctr: string;
    watchTimeHours: string;
    publishedAt: string | null;
  }>;
  analytics: {
    recentDays: Array<{
      date: string;
      views: number;
      subscribers: number;
      ctr: string;
      watchTimeHours: string;
      impressions: string;
      revenue: string;
    }>;
  };
  movies: Array<{
    chineseName: string;
    vietnameseName: string | null;
    status: string;
    score: string;
    trendScore: string;
    tags: string[] | null;
  }>;
  googleTrends: Array<{
    keyword: string;
    trendScore: number;
    searchVolume: number;
  }>;
}

export interface AiRecommendationOutput {
  summary: string;
  recommendations: Array<{
    movie: string;
    score: number;
    priority: string;
    reason: string;
    risk: string;
    expectedViews: string;
    expectedCtr: string;
  }>;
  warnings: string[];
  nextActions: string[];
}

export interface AiChatResponse {
  content: string;
  structuredData?: Record<string, unknown>;
}

export interface AiProvider {
  analyze(input: AiAnalysisInput): Promise<AiRecommendationOutput>;
  chat(systemContext: string, userMessage: string, history?: Array<{ role: string; content: string }>): Promise<AiChatResponse>;
}
