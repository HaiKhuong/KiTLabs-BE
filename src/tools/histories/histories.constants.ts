export const UNIFIED_HISTORY_SOURCES = ["media", "voice", "shortVideo", "whiteboard"] as const;

export type UnifiedHistorySource = (typeof UNIFIED_HISTORY_SOURCES)[number];

export const UNIFIED_HISTORY_DEFAULT_LIMIT = 20;
export const UNIFIED_HISTORY_MAX_LIMIT = 50;

export const UNIFIED_HISTORY_UNION_SQL = `
  SELECT
    id::text AS id,
    'media'::text AS source,
    COALESCE(result_file_name, 'output.mp4') AS name,
    updated_at AS completed_at,
    result_path AS result_path
  FROM translate_histories
  WHERE user_id = $1 AND status = 'completed'

  UNION ALL

  SELECT
    id::text AS id,
    'voice'::text AS source,
    display_name AS name,
    updated_at AS completed_at,
    result_path AS result_path
  FROM audio_histories
  WHERE user_id = $1 AND status = 'completed'

  UNION ALL

  SELECT
    id::text AS id,
    'shortVideo'::text AS source,
    COALESCE(display_name, result_file_name, 'Short video') AS name,
    COALESCE(render_finished_at, updated_at) AS completed_at,
    result_path AS result_path
  FROM short_video_histories
  WHERE user_id = $1 AND status = 'completed'

  UNION ALL

  SELECT
    id::text AS id,
    'whiteboard'::text AS source,
    COALESCE(display_name, result_file_name, 'Whiteboard') AS name,
    COALESCE(render_finished_at, updated_at) AS completed_at,
    result_path AS result_path
  FROM whiteboard_histories
  WHERE user_id = $1 AND status = 'completed' AND queue_job_id IS NOT NULL
`;
