"""
Fetch Google Trends data for given keywords.
Outputs JSON to stdout for NestJS to consume.

Usage:
  python fetch_trends.py --keywords '["keyword1", "keyword2"]' --region VN
"""

import argparse
import json
import sys
import time

from pytrends.request import TrendReq


def fetch_trends(keywords: list[str], region: str = "VN") -> list[dict]:
    """Fetch trend data for a list of keywords."""
    results = []
    pytrends = TrendReq(hl="vi", tz=420)

    # pytrends supports max 5 keywords per request
    batch_size = 5
    for i in range(0, len(keywords), batch_size):
        batch = keywords[i : i + batch_size]

        try:
            pytrends.build_payload(batch, cat=0, timeframe="today 3-m", geo=region)
            interest_df = pytrends.interest_over_time()

            for keyword in batch:
                trend_data = {
                    "keyword": keyword,
                    "trendScore": 0,
                    "searchVolume": 0,
                    "relatedQueries": {},
                }

                if not interest_df.empty and keyword in interest_df.columns:
                    values = interest_df[keyword].tolist()
                    trend_data["trendScore"] = int(values[-1]) if values else 0
                    trend_data["searchVolume"] = int(sum(values) / len(values)) if values else 0

                # Fetch related queries
                try:
                    related = pytrends.related_queries()
                    if keyword in related and related[keyword]["top"] is not None:
                        top_queries = related[keyword]["top"].head(10).to_dict("records")
                        trend_data["relatedQueries"] = {"top": top_queries}
                except Exception:
                    pass

                results.append(trend_data)

        except Exception as e:
            # If rate-limited or error, return zero scores for this batch
            for keyword in batch:
                results.append(
                    {
                        "keyword": keyword,
                        "trendScore": 0,
                        "searchVolume": 0,
                        "relatedQueries": {},
                    }
                )
            print(f"Warning: {e}", file=sys.stderr)

        # Avoid rate limiting between batches
        if i + batch_size < len(keywords):
            time.sleep(2)

    return results


def main():
    parser = argparse.ArgumentParser(description="Fetch Google Trends data")
    parser.add_argument("--keywords", type=str, required=True, help="JSON array of keywords")
    parser.add_argument("--region", type=str, default="VN", help="Geo region code")
    args = parser.parse_args()

    keywords = json.loads(args.keywords)

    if not keywords:
        print(json.dumps([]))
        return

    results = fetch_trends(keywords, args.region)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
