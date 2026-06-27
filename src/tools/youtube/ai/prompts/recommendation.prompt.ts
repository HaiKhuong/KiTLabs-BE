export const RECOMMENDATION_PROMPT = `Analyze the following YouTube channel data and provide content recommendations.

Input data:
{DATA}

Based on this data, perform the following analysis:
1. Evaluate current channel performance (views trend, CTR, subscriber growth).
2. Identify top content opportunities from the movie database.
3. Score each movie candidate based on: Popularity + Google Trend + Audience Match + Historical Performance - Competition + Long-term Potential.
4. Assess risks for each recommendation.
5. Suggest a weekly content plan.

Return ONLY valid JSON in this exact format:
{
  "summary": "Brief overview of channel health and key insights",
  "recommendations": [
    {
      "movie": "Movie chinese name",
      "score": 0-100,
      "priority": "High|Medium|Low",
      "reason": "Why this movie is recommended",
      "risk": "Potential risks",
      "expectedViews": "Estimated view range",
      "expectedCtr": "Estimated CTR percentage"
    }
  ],
  "warnings": ["Any concerns about channel performance"],
  "nextActions": ["Actionable steps for the next week"]
}`;
