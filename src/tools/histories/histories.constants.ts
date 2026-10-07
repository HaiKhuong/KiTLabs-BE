export const UNIFIED_HISTORY_SOURCES = [
  "media",
  "voice",
  "shortVideo",
  "whiteboard",
  "recap",
] as const;

export type UnifiedHistorySource = (typeof UNIFIED_HISTORY_SOURCES)[number];

export const HISTORY_SOFT_DELETE_TABLES: Record<UnifiedHistorySource, readonly string[]> = {
  media: ["translate_histories"],
  voice: ["audio_histories"],
  shortVideo: ["short_video_histories"],
  whiteboard: ["whiteboard_histories"],
  recap: ["recap_histories", "narrato_histories"],
};

export const UNIFIED_HISTORY_DEFAULT_LIMIT = 20;
export const UNIFIED_HISTORY_MAX_LIMIT = 50;

export const UNIFIED_HISTORY_UNION_SQL = `
  SELECT
    id::text AS id,
    'media'::text AS source,
    COALESCE(
      result_file_name,
      NULLIF(
        regexp_replace(
          COALESCE(engine_config->>'localVideoPath', engine_config->>'local_video_path', ''),
          '^.*[\\\\/]',
          ''
        ),
        ''
      ),
      'output.mp4'
    ) AS name,
    updated_at AS completed_at,
    result_path AS result_path,
    NULL::text AS preview_text,
    'media'::text AS artifact_kind,
    status::text AS job_status,
    COALESCE(engine_config->>'localVideoPath', engine_config->>'local_video_path') AS video_path
  FROM translate_histories
  WHERE user_id = $1
    AND status IN ('pending', 'running', 'completed')
    AND deleted_at IS NULL

  UNION ALL

  SELECT
    id::text AS id,
    'voice'::text AS source,
    display_name AS name,
    updated_at AS completed_at,
    result_path AS result_path,
    input_text AS preview_text,
    'voice'::text AS artifact_kind,
    status::text AS job_status,
    NULL::text AS video_path
  FROM audio_histories
  WHERE user_id = $1
    AND status IN ('pending', 'running', 'completed')
    AND deleted_at IS NULL

  UNION ALL

  SELECT
    id::text AS id,
    'shortVideo'::text AS source,
    COALESCE(display_name, result_file_name, 'Short video') AS name,
    COALESCE(render_finished_at, updated_at) AS completed_at,
    result_path AS result_path,
    NULL::text AS preview_text,
    'shortVideo'::text AS artifact_kind,
    status::text AS job_status,
    NULL::text AS video_path
  FROM short_video_histories
  WHERE user_id = $1
    AND status IN ('pending', 'running', 'completed')
    AND deleted_at IS NULL

  UNION ALL

  SELECT
    id::text AS id,
    'whiteboard'::text AS source,
    COALESCE(display_name, result_file_name, 'Whiteboard') AS name,
    COALESCE(render_finished_at, updated_at) AS completed_at,
    result_path AS result_path,
    NULL::text AS preview_text,
    'whiteboard'::text AS artifact_kind,
    status::text AS job_status,
    NULL::text AS video_path
  FROM whiteboard_histories
  WHERE user_id = $1
    AND deleted_at IS NULL
    AND (
      status IN ('pending', 'running')
      OR (status = 'completed' AND queue_job_id IS NOT NULL)
    )

  UNION ALL

  SELECT
    id::text AS id,
    'recap'::text AS source,
    COALESCE(display_name, result_file_name, 'Recap') AS name,
    updated_at AS completed_at,
    result_path AS result_path,
    NULL::text AS preview_text,
    'recap'::text AS artifact_kind,
    status::text AS job_status,
    NULL::text AS video_path
  FROM recap_histories
  WHERE user_id = $1
    AND deleted_at IS NULL
    AND (
      status IN ('pending', 'running')
      OR (status = 'completed' AND result_path IS NOT NULL AND result_path <> '')
    )

  UNION ALL

  SELECT
    id::text AS id,
    'recap'::text AS source,
    COALESCE(display_name, result_file_name, 'Narrato') AS name,
    updated_at AS completed_at,
    result_path AS result_path,
    NULL::text AS preview_text,
    'narrato'::text AS artifact_kind,
    status::text AS job_status,
    NULL::text AS video_path
  FROM narrato_histories
  WHERE user_id = $1
    AND deleted_at IS NULL
    AND (
      status IN ('pending', 'running')
      OR (status = 'completed' AND result_path IS NOT NULL AND result_path <> '')
    )
`;
